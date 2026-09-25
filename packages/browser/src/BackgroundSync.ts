/**
 * BackgroundSync
 *
 * Flush the journal after the tab is gone (#213). `BrowserConnectivity`
 * covers every case where a page is open — `online`/`offline`, and a
 * return-to-visible as a poke — but by construction none of those fire when
 * there is no page. A write journaled offline and then left behind by a
 * closed tab would wait until the user came back. Background Sync is the
 * browser's answer: the page (or the worker, while a page is open) registers
 * a tag, and when the browser judges connectivity to be back it wakes the
 * service worker with a `sync` event for that tag — tab or no tab.
 *
 * The flush **is `ClientEngine.push`**, not a replay loop. The journal is
 * already ordered, and every entry carries a per-client mutation id the
 * backend's ledger applies exactly once, so:
 *
 * - a push that landed but whose response was lost is re-sent and **skipped**
 *   by the ledger, never applied twice — no client-generated-id-plus-re-fetch
 *   scheme is needed to prove a retry was one's own;
 * - a write the backend refuses is a **permanent rejection**: acknowledged
 *   and skipped so it cannot wedge the entries behind it, its optimistic
 *   effect dropped, and the refusal kept in `mutationStates` with its reason
 *   — surfaced, not discarded. The user's write never silently vanishes.
 *
 * A hand-rolled outbox that replays raw HTTP requests can have neither
 * property; that is the reason to delete one in favour of this.
 *
 * There is no retry ladder here either. A flush that fails on the transport
 * rejects the event's `waitUntil` promise, which is the browser's own cue to
 * reschedule the sync with its own backoff; the journal is untouched, and the
 * next connectivity signal flushes it regardless.
 *
 * ## The three pieces
 *
 * - {@link listen} — the worker's `sync` listener. Call it **synchronously at
 *   the top level of the worker script**: a worker woken for a `sync` event
 *   evaluates its script and dispatches the event straight after, so a
 *   listener added once an Effect program has opened IndexedDB and built the
 *   engine would miss exactly the wake this module exists for. The listener
 *   holds the event open until a host attaches, then flushes.
 * - `ServiceWorkerHost.start({ backgroundSync: listener })` — attaches the
 *   host's engine to the listener for the host's lifetime, and registers the
 *   tag whenever a mutation is journaled while a page is open.
 * - {@link register} — the page-side registration, for an app that wants to
 *   ask from the page after a journaled mutation. Best-effort by design.
 *
 * ## Only the library's tag
 *
 * A service worker delivers every Background Sync registration on the origin
 * to the same `sync` handler. The listener answers {@link defaultTag} (or the
 * tag it was given) and nothing else: flushing in response to an unrelated
 * tag would push writes at a moment chosen by someone else's code. A foreign
 * tag's event is left untouched — no `waitUntil`, so whoever registered it
 * still owns its outcome.
 *
 * ## Absence is a working state
 *
 * Background Sync is Chromium-only: on Safari and Firefox there is no
 * `SyncManager`, and that is the common case, not a fault. {@link register}
 * reports `"Unsupported"` at debug level and nothing more; the journal still
 * flushes on the next `BrowserConnectivity` signal (reconnect or
 * return-to-visible) the next time a page is open.
 *
 * ## The identity boundary
 *
 * A background flush runs with no page and no user present, so it must not
 * push a journal that belongs to a superseded identity (#212). Two layers
 * guarantee that:
 *
 * - **Quarantine is structural.** A reset moves the superseded identity's
 *   unpushed entries into a keyspace `push` cannot read, so a sync event never
 *   pushes them, whoever is signed in.
 * - **The worker may not know a reset happened.** A tab that closed before the
 *   app called `Client.reset` leaves the store stamped for the old identity.
 *   Give {@link ListenOptions.identity} an Effect that resolves the
 *   fingerprint of whoever is signed in now, and the flush compares it with
 *   the stamp first: anything but an exact match skips the flush
 *   (`"IdentityChanged"`) and leaves the journal for the next page boot to
 *   reset or upgrade. Skipping is the only safe move from a context with no UI.
 *
 * ## Periodic Background Sync
 *
 * Deliberately not here. A periodic pull has a different permission story
 * (an installed-app engagement heuristic the browser can withdraw) and is an
 * easy way to spend a user's battery; it is a separate decision. A worker
 * that wants one can call `ClientEngine.pull` from its own `periodicsync`
 * listener.
 */

import type { Identity, StoreError, TransportError } from "@legation/effect";
import type { ClientEngine } from "@legation/effect/internal";
import { Data, Duration, Effect, Option, Scope, Stream, SubscriptionRef } from "effect";
import type { Context } from "effect";

/**
 * The tag the library registers and answers. Short on purpose: Chromium
 * refuses over-long tags.
 */
export const defaultTag = "legation-flush";

/** How long a `sync` event waits for a host to attach before giving up. */
export const defaultReadyTimeout: Duration.Input = "30 seconds";

// ─── Platform shapes ─────────────────────────────────────────────────────────
//
// Background Sync is not a cross-browser standard, so the DOM lib declares
// neither `SyncManager` nor `ServiceWorkerRegistration.sync`, nor the
// worker's `SyncEvent`. These are the structural slices this module touches,
// which also lets a test pass a fake `self`.

/** `SyncManager`: absent where the browser has no Background Sync. */
export interface SyncManager {
  readonly register: (tag: string) => Promise<void>;
}

/**
 * A `ServiceWorkerRegistration`, or any stand-in for one. Typed as `object`
 * rather than a slice with an optional `sync`, because TypeScript's weak-type
 * check would then refuse a real registration (whose declared type has no
 * `sync`); the member is probed at runtime instead (see `syncManagerOf`).
 */
export type SyncRegistration = object;

/** The registration's `SyncManager`, if the browser gives it one. */
const syncManagerOf = (registration: SyncRegistration | undefined): SyncManager | undefined => {
  const sync: unknown =
    registration !== undefined && "sync" in registration ? registration.sync : undefined;
  return typeof sync === "object" &&
    sync !== null &&
    "register" in sync &&
    typeof sync.register === "function"
    ? (sync as SyncManager)
    : undefined;
};

/** The slice of the worker's `SyncEvent` the listener reads. */
export interface SyncEvent {
  readonly tag: string;
  /** Chromium: `true` when the browser will not retry this registration again. */
  readonly lastChance?: boolean;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * The slice of `ServiceWorkerGlobalScope` the listener needs — `self` in a
 * worker. `registration` is where the host registers the tag from.
 */
export interface SyncScope {
  readonly addEventListener: (type: "sync", listener: (event: SyncEvent) => void) => void;
  readonly registration?: SyncRegistration | undefined;
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * What asking for a sync did. None of these is a failure: registration is
 * advisory, and the journal flushes on the connectivity path whatever
 * happens here.
 *
 * - `Registered` — the browser will fire the tag's `sync` event.
 * - `Unsupported` — no service-worker registration, or no `SyncManager` on
 *   it (Safari, Firefox): the connectivity path flushes.
 * - `Refused` — the browser declined (permission withheld, no active worker,
 *   or — from inside a worker — no window of the origin open).
 */
export type RegisterOutcome = "Registered" | "Unsupported" | "Refused";

export interface RegisterOptions {
  /** Defaults to {@link defaultTag}; must match the listener's. */
  readonly tag?: string;
  /**
   * Where to register. Defaults to the page's own service-worker
   * registration (`navigator.serviceWorker.getRegistration()` — never
   * `ready`, which would wait forever on a page no worker controls).
   */
  readonly registration?: Effect.Effect<SyncRegistration | undefined>;
}

/** The page's service-worker registration, or `undefined` where there is none. */
const pageRegistration: Effect.Effect<SyncRegistration | undefined> = Effect.suspend(() => {
  const container: ServiceWorkerContainer | undefined =
    typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  return container === undefined
    ? Effect.undefined
    : Effect.tryPromise(() => container.getRegistration()).pipe(
        Effect.orElseSucceed(() => undefined)
      );
});

/**
 * Ask the browser to wake the worker with the library's `sync` event once
 * connectivity is back. Call it from the page after a journaled mutation, or
 * let `ServiceWorkerHost` do it from the worker (see {@link ListenOptions}).
 *
 * Never fails and never logs above debug level: absence is the common case
 * (Background Sync is Chromium-only), and the journal still flushes on the
 * next connectivity signal. Registering a tag that is already pending is a
 * no-op for the browser, so calling it once per mutation is fine.
 */
export const register = (options: RegisterOptions = {}): Effect.Effect<RegisterOutcome> =>
  Effect.gen(function* () {
    const tag = options.tag ?? defaultTag;
    const registration = yield* options.registration ?? pageRegistration;
    const sync = syncManagerOf(registration);
    if (sync === undefined) {
      yield* Effect.logDebug(
        "Background Sync unavailable; the journal flushes on the next connectivity signal"
      );
      return "Unsupported" as const;
    }
    return yield* Effect.tryPromise(() => sync.register(tag)).pipe(
      Effect.as("Registered" as const),
      Effect.catch((cause) =>
        Effect.logDebug("Background Sync registration refused", cause).pipe(
          Effect.as("Refused" as const)
        )
      )
    );
  });

/**
 * Register the tag every time `engine` journals a mutation, for the scope's
 * lifetime. The host's side of {@link register}: in the service-worker
 * topology a page's mutation is journaled in the worker, so the worker is the
 * one that knows. Chromium only accepts a registration from a worker while a
 * window of the origin is open — which is exactly when a mutation arrives
 * from a mirror — and a refusal is still only a debug line.
 */
export const registerOnJournal = (
  engine: ClientEngine.ClientEngine,
  options: RegisterOptions = {}
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forkScoped(
    engine.engineEvents.pipe(
      Stream.filter((event) => event._tag === "MutationJournaled"),
      Stream.runForEach(() => register(options))
    ),
    // Subscribe before returning, so a mutation journaled straight after
    // the host starts is not missed.
    { startImmediately: true }
  ).pipe(Effect.asVoid);

// ─── The flush ───────────────────────────────────────────────────────────────

/**
 * What a flush did. Each is a settled outcome — the `sync` event resolves and
 * the browser does not retry:
 *
 * - `Flushed` — the journal was pushed. Acknowledged entries are trimmed and
 *   their optimistic effects dropped; a permanently rejected one settles as
 *   `rejected` in `mutationStates`, with its reason.
 * - `IdentityChanged` — the store is not stamped for whoever is signed in now
 *   (see {@link ListenOptions.identity}); nothing was pushed, and the journal
 *   waits for the next page boot to apply the boundary's transition.
 * - `UpdateNeeded` — the server rejected this build's schema version; the
 *   journal is retained and `onUpdateNeeded` has fired. Retrying cannot help
 *   until the app updates.
 */
export type FlushOutcome = "Flushed" | "IdentityChanged" | "UpdateNeeded";

export interface FlushOptions {
  /** See {@link ListenOptions.identity}. */
  readonly identity?: Effect.Effect<Identity.Fingerprint | undefined>;
}

/**
 * Flush `engine`'s journal through the ordinary push path, behind the
 * identity check. Fails — so the `sync` event rejects and the browser
 * reschedules — only on a transport or store failure, with the journal
 * intact.
 */
export const flush = (
  engine: ClientEngine.ClientEngine,
  options: FlushOptions = {}
): Effect.Effect<FlushOutcome, TransportError | StoreError> =>
  Effect.gen(function* () {
    if (options.identity !== undefined) {
      const current = yield* options.identity;
      const stamped = yield* engine.identity;
      // Exact match only. `undefined` (the app cannot say who is signed in),
      // an unstamped store, and even the benign anonymous → signed-in upgrade
      // are all left to a page boot: a context with no UI does not adopt an
      // identity on the user's behalf.
      if (current === undefined || stamped !== current) {
        yield* Effect.logDebug(
          "Background Sync flush skipped: the replica is not stamped for the current identity"
        );
        return "IdentityChanged" as const;
      }
    }
    return yield* engine.push.pipe(
      Effect.as("Flushed" as const),
      Effect.catchTag("VersionNotSupportedError", () => Effect.succeed("UpdateNeeded" as const))
    );
  }).pipe(Effect.withSpan("legation.backgroundSync.flush"));

// ─── The listener ────────────────────────────────────────────────────────────

/** No host attached the listener within its `readyTimeout`. */
export class HostNotReady extends Data.TaggedError("HostNotReady")<{
  readonly tag: string;
  readonly message: string;
}> {}

export interface ListenOptions {
  /** The tag to answer, and to register from the host. Defaults to {@link defaultTag}. */
  readonly tag?: string;
  /** The worker's global scope. Defaults to `globalThis` (`self` in a worker). */
  readonly scope?: SyncScope;
  /**
   * How long a `sync` event waits for a host to attach before rejecting, so
   * the browser reschedules it. Defaults to {@link defaultReadyTimeout}. A
   * worker that only boots its host on a page's handshake never attaches on
   * a tab-less wake; boot the host at worker start for background flushing.
   */
  readonly readyTimeout?: Duration.Input;
  /**
   * The fingerprint of whoever is signed in **now**, as the app resolves it
   * from inside the worker (e.g. a session-subject hash it keeps beside its
   * session). When set, a flush pushes only if the store's stamp equals it;
   * `undefined` means "cannot tell" and skips. Unset, the flush relies on the
   * store's own boundary alone: quarantined entries are unreachable from push
   * either way.
   */
  readonly identity?: Effect.Effect<Identity.Fingerprint | undefined>;
  /**
   * Register the tag from the worker whenever the attached engine journals a
   * mutation (see {@link registerOnJournal}). Defaults to `true`; turn it off
   * when the page registers with {@link register} itself.
   */
  readonly registerOnJournal?: boolean;
}

/**
 * The worker's `sync` listener, created by {@link listen}. It answers its
 * tag from the moment it exists; a host attaches an engine with
 * {@link Listener.serve}, which `ServiceWorkerHost.start` does when given the
 * listener as `backgroundSync`.
 */
export interface Listener {
  /** The tag this listener answers. */
  readonly tag: string;
  /**
   * Attach `engine` for the scope's lifetime: `sync` events for the tag —
   * including any that arrived before this call — flush its journal, run
   * under the caller's services (logger, tracer). Closing the scope detaches
   * it; a later event then waits for the next host.
   */
  readonly serve: (engine: ClientEngine.ClientEngine) => Effect.Effect<void, never, Scope.Scope>;
}

interface Attached {
  readonly flush: Effect.Effect<FlushOutcome, TransportError | StoreError>;
  /** The host's services, so a flush logs and traces as the host does. */
  readonly services: Context.Context<never>;
}

/**
 * Install the `sync` listener on the worker's scope — **synchronously, at the
 * top level of the worker script** (see the module docs for why). Deliberately
 * a plain function rather than an Effect for that reason.
 *
 * ```ts
 * // service-worker.ts, top level
 * const backgroundSync = BackgroundSync.listen({ identity: currentFingerprint });
 * // ... later, once the engine's layers are built:
 * yield* ServiceWorkerHost.start({ backgroundSync, registry, nodes, urls });
 * ```
 */
export const listen = (options: ListenOptions = {}): Listener => {
  const tag = options.tag ?? defaultTag;
  const scope = options.scope ?? (globalThis as unknown as Partial<SyncScope>);
  const readyTimeout = options.readyTimeout ?? defaultReadyTimeout;
  const attached = Effect.runSync(SubscriptionRef.make(Option.none<Attached>()));

  // The first attached host, however long it takes to arrive (bounded).
  // `changes` emits the current value first and never ends, so the head
  // exists as soon as some host is attached.
  const whenAttached: Effect.Effect<Attached, HostNotReady> = SubscriptionRef.changes(
    attached
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map((some) => some.value),
    Stream.runHead,
    Effect.flatMap((head) => (Option.isSome(head) ? Effect.succeed(head.value) : Effect.never)),
    Effect.timeoutOrElse({
      duration: readyTimeout,
      orElse: () =>
        Effect.fail(
          new HostNotReady({
            tag,
            message: `No engine host attached within ${Duration.format(Duration.fromInputUnsafe(readyTimeout))}; the browser will reschedule the sync`,
          })
        ),
    })
  );

  const handle = (event: SyncEvent): Promise<FlushOutcome> =>
    Effect.runPromise(
      whenAttached.pipe(
        Effect.tapError((error) => Effect.logDebug(error.message)),
        Effect.flatMap(({ flush: run, services }) =>
          run.pipe(
            Effect.tapError((error) =>
              error._tag === "TransportError"
                ? Effect.logDebug(
                    event.lastChance === true
                      ? "Background Sync flush failed on its last chance; the journal flushes on the next connectivity signal"
                      : "Background Sync flush failed; the browser will reschedule it",
                    error
                  )
                : Effect.logWarning("Background Sync flush failed on the store", error)
            ),
            Effect.provideContext(services)
          )
        )
      )
    );

  const listener = (event: SyncEvent): void => {
    // Not ours: leave the event alone so its owner decides its outcome.
    if (event.tag !== tag) return;
    event.waitUntil(handle(event));
  };
  scope.addEventListener?.("sync", listener);

  const registration = Effect.sync(() => scope.registration);
  const serve: Listener["serve"] = (engine) =>
    Effect.gen(function* () {
      const entry: Attached = {
        flush: flush(engine, options.identity === undefined ? {} : { identity: options.identity }),
        services: yield* Effect.context<never>(),
      };
      yield* Effect.acquireRelease(SubscriptionRef.set(attached, Option.some(entry)), () =>
        // Detach only ourselves: a newer host may already have attached.
        SubscriptionRef.update(attached, (current) =>
          Option.isSome(current) && current.value === entry ? Option.none() : current
        )
      );
      if (options.registerOnJournal !== false) {
        yield* registerOnJournal(engine, { tag, registration });
      }
    });

  return { tag, serve };
};
