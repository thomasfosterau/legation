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
 *   tag when the journal cannot drain now (see below).
 * - {@link register} — the page-side registration, for an app that wants to
 *   ask from the page when a write could not be sent. Best-effort by design.
 *
 * ## Register only when the journal cannot drain
 *
 * Online, Chromium fires a fresh registration's `sync` event almost at once,
 * and the flush is a direct `push`. Registering after every mutation would
 * therefore give every online write its own push — bypassing the sync loop's
 * `pushDebounce`, and defeating paced compaction (#117), since
 * `dropIfPending` never touches an entry a push has claimed (#246). So the
 * host registers only in the two cases the sync loop cannot cover by itself:
 * a mutation journaled while the worker is **offline**, and a push that
 * **failed terminally** (the engine's retry policy exhausted). Online, the
 * sync loop drains the journal as it always has.
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
 *   app called `Client.reset` leaves the store stamped for the old identity,
 *   and quarantine cannot help: nothing moved. So {@link ListenOptions.identity}
 *   is **required** — an Effect that resolves the fingerprint of whoever is
 *   signed in now, which the flush compares with the stamp first: anything but
 *   an exact match skips the flush (`"IdentityChanged"`) and leaves the
 *   journal for the next page boot to reset or upgrade. Skipping is the only
 *   safe move from a context with no UI. An app with no signed-in identity at
 *   all passes {@link identityUnchecked} to say so explicitly.
 *
 * ## Periodic Background Sync
 *
 * Deliberately not here. A periodic pull has a different permission story
 * (an installed-app engagement heuristic the browser can withdraw) and is an
 * easy way to spend a user's battery; it is a separate decision. A worker
 * that wants one can call `ClientEngine.pull` from its own `periodicsync`
 * listener.
 */

import type { Identity, StoreError, TransportError } from "@thomasfosterau/legation-effect";
import type { ClientEngine } from "@thomasfosterau/legation-effect/internal";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Context from "effect/Context";

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

/**
 * The view of a {@link SyncRegistration} that {@link syncManagerOf} probes:
 * any object may stand in, and `sync` is read without trusting its shape.
 */
interface ProbedRegistration {
  readonly sync?: unknown;
}

/** Whether a probed `sync` member is a `SyncManager`: an object with a `register` method. */
const isSyncManager = (sync: unknown): sync is SyncManager =>
  P.isObjectOrArray(sync) && "register" in sync && P.isFunction(sync.register);

/** The registration's `SyncManager`, if the browser gives it one. */
const syncManagerOf = (registration: ProbedRegistration | undefined): SyncManager | undefined => {
  const sync = registration?.sync;
  return isSyncManager(sync) ? sync : undefined;
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

/** Options for {@link register}. */
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
  const container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker;
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

/** Whether the worker's own view says the network is down. */
const navigatorOffline: Effect.Effect<boolean> = Effect.sync(
  () => globalThis.navigator?.onLine === false
);

/** Options for {@link registerOnJournal}. */
export interface RegisterOnJournalOptions extends RegisterOptions {
  /**
   * Whether the journal cannot drain right now. Defaults to
   * `navigator.onLine === false` in the worker (`WorkerNavigator.onLine`).
   */
  readonly offline?: Effect.Effect<boolean>;
}

/**
 * Register the tag for the scope's lifetime whenever `engine`'s journal
 * cannot drain now — the host's side of {@link register}, since in the
 * service-worker topology a page's mutation is journaled in the worker:
 *
 * - a mutation is journaled while {@link RegisterOnJournalOptions.offline}
 *   holds; and
 * - a push fails terminally (`ClientEngine.syncFailures`, after the retry
 *   policy is exhausted) — reachable network, unreachable backend.
 *
 * Never on an online mutation: the sync loop drains those, debounced and
 * compacted, and an online registration would fire `sync` at once and push
 * each write on its own (#246). Chromium only accepts a registration from a
 * worker while a window of the origin is open; a refusal is a debug line.
 */
export const registerOnJournal = (
  engine: ClientEngine.ClientEngine,
  options: RegisterOnJournalOptions = {}
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const offline = options.offline ?? navigatorOffline;
    // Two forks rather than one merged stream: each subscribes synchronously
    // (`startImmediately`) before this returns, so a mutation journaled
    // straight after the host starts is not missed. (`Stream.merge` would
    // subscribe on fibers of its own, later.)
    const registerOn = <A>(stream: Stream.Stream<A>) =>
      Effect.forkScoped(
        Stream.runForEach(stream, () => register(options)),
        {
          startImmediately: true,
        }
      );
    yield* registerOn(
      engine.engineEvents.pipe(
        Stream.filter((event) => event._tag === "MutationJournaled"),
        Stream.filterEffect(() => offline)
      )
    );
    yield* registerOn(
      engine.syncFailures.pipe(Stream.filter((failure) => failure.operation === "push"))
    );
  });

// ─── The flush ───────────────────────────────────────────────────────────────

/**
 * What a flush did. Each is a settled outcome — the `sync` event resolves and
 * the browser does not retry:
 *
 * - `Flushed` — the push completed (possibly with nothing pending).
 *   Acknowledged entries are trimmed and their optimistic effects dropped; a
 *   permanently rejected one settles as `rejected` in `mutationStates`, with
 *   its reason.
 * - `IdentityChanged` — the store is not stamped for whoever is signed in now
 *   (see {@link ListenOptions.identity}); nothing was pushed, and the journal
 *   waits for the next page boot to apply the boundary's transition.
 * - `UpdateNeeded` — the server rejected this build's schema version; the
 *   journal is retained and `onUpdateNeeded` has fired. Retrying cannot help
 *   until the app updates.
 */
export type FlushOutcome = "Flushed" | "IdentityChanged" | "UpdateNeeded";

/**
 * The explicit opt-out from the flush's identity check, for an app with **no
 * signed-in identity at all** (every session is the same public principal).
 * The flush then relies on the store's boundary alone: quarantined entries
 * are still unreachable from push, but a store still stamped for a user who
 * signed out in a tab that closed before `Client.reset` ran **would be
 * pushed**. Never pass this in an app that has sign-in.
 */
export const identityUnchecked: unique symbol = Symbol.for(
  "@thomasfosterau/legation-browser/identityUnchecked"
);

/**
 * Who is signed in now, as the app resolves it inside the worker — or
 * {@link identityUnchecked}. See {@link ListenOptions.identity}.
 */
export type IdentitySource =
  | Effect.Effect<Identity.Fingerprint | undefined>
  | typeof identityUnchecked;

/** Options for {@link flush}. */
export interface FlushOptions {
  /** See {@link ListenOptions.identity}. */
  readonly identity: IdentitySource;
}

/**
 * Flush `engine`'s journal through the ordinary push path, behind the
 * identity check. A journal larger than half the engine's unpulled bound goes
 * in chunks with a pull before each chunk after the first, so a flush may
 * pull (#429); a smaller journal is pushed without pulling. Fails — so the
 * `sync` event rejects and the browser reschedules — on a transport or store
 * failure, with the journal intact. A pull between chunks that fails is a
 * transport failure of the same kind, so the flush never reports `Flushed`
 * over a journal it stopped short of.
 */
export const flush = (
  engine: ClientEngine.ClientEngine,
  options: FlushOptions
): Effect.Effect<FlushOutcome, TransportError | StoreError> =>
  Effect.gen(function* () {
    if (options.identity !== identityUnchecked) {
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

/** Options for {@link listen}. */
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
   * **Required.** The fingerprint of whoever is signed in **now**, as the app
   * resolves it from inside the worker (e.g. a session-subject hash it keeps
   * beside its session). A flush pushes only if the store's stamp equals it
   * exactly; `undefined` means "cannot tell" and skips.
   *
   * Required rather than optional because the store's own boundary covers
   * only a reset that ran: a tab closed before `Client.reset` leaves the old
   * identity's journal in the pushable keyspace, and a background flush would
   * send it under whoever's cookies the worker now carries. An app with no
   * sign-in passes {@link identityUnchecked}, which accepts that risk
   * explicitly.
   */
  readonly identity: IdentitySource;
  /**
   * Register the tag from the worker when the attached engine's journal
   * cannot drain now (see {@link registerOnJournal}). Defaults to `true`;
   * turn it off when the page registers with {@link register} itself.
   */
  readonly registerOnJournal?: boolean;
  /**
   * Whether the journal cannot drain now, for {@link registerOnJournal}.
   * Defaults to `navigator.onLine === false`.
   */
  readonly offline?: Effect.Effect<boolean>;
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
export const listen = (options: ListenOptions): Listener => {
  const tag = options.tag ?? defaultTag;
  const scope: Partial<SyncScope> = options.scope ?? globalThis;
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
        Effect.tapError((error) =>
          Effect.logDebug(
            event.lastChance === true
              ? `${error.message} (the browser's last chance; the journal flushes on the next connectivity signal)`
              : error.message
          )
        ),
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
        flush: flush(engine, { identity: options.identity }),
        services: yield* Effect.context<never>(),
      };
      yield* Effect.acquireRelease(SubscriptionRef.set(attached, Option.some(entry)), () =>
        // Detach only ourselves: a newer host may already have attached.
        SubscriptionRef.update(attached, (current) =>
          Option.isSome(current) && current.value === entry ? Option.none() : current
        )
      );
      if (options.registerOnJournal !== false) {
        yield* registerOnJournal(engine, {
          tag,
          registration,
          ...(options.offline === undefined ? {} : { offline: options.offline }),
        });
      }
    });

  return { tag, serve };
};
