/**
 * PushPoke
 *
 * The worker side of Web Push as a poke carrier (#214): a `push` listener that
 * turns the library's push into convergence for a client with no open tab. The
 * server side, which sends the push within the app's stated budget, is
 * `PushPoke.sink` in `@thomasfosterau/legation-effect/internal`.
 *
 * ## What a recognised push does
 *
 * The push carries the library's marker (`PushPoke.payload`) and nothing else.
 * The listener recognises it and, by default, **registers a Background Sync**
 * (the flush path of #213), so the browser runs the sync when it judges the
 * connection good: the kinder default on a metered connection. An app that
 * wants the replica current at once opts in to `action: "pull"`, which pulls
 * directly. Either way, the pull the poke prompts is where the data travels.
 *
 * ## Coexisting with the app's own `push` handler
 *
 * A worker has one `push` event for every push on the origin. The listener
 * acts only on the library's marker and leaves every other push untouched (no
 * `waitUntil`), so the app's own handler, its notifications, keeps working.
 * Showing a notification for a silent push is the app's business; see the
 * README on the budget browsers enforce.
 *
 * ## The identity boundary
 *
 * A push may arrive for a user who has since signed out on this device. Before
 * acting, the listener compares who is signed in now with the replica's stamp,
 * as the Background Sync flush does (#212): anything but an exact match does
 * nothing (`"IdentityChanged"`), so a push for a superseded identity never
 * pulls, or schedules a push, under the new one.
 *
 * Install it **synchronously at the top level of the worker script**, like
 * `BackgroundSync.listen`: a worker woken for a `push` evaluates its script and
 * dispatches the event straight after.
 */

import type { ClientEngine } from "@thomasfosterau/legation-effect/internal";
import { PushPoke as Marker } from "@thomasfosterau/legation-effect/internal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as BackgroundSync from "./BackgroundSync.js";

/** The slice of a worker's `PushEvent` the listener reads. */
export interface PushEvent {
  /** The push's data (`PushMessageData`, or `null` for a push without any). */
  readonly data: unknown;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** The slice of `ServiceWorkerGlobalScope` the listener needs — `self` in a worker. */
export interface PushScope {
  readonly addEventListener: (type: "push", listener: (event: PushEvent) => void) => void;
  readonly registration?: BackgroundSync.SyncRegistration;
}

/**
 * What a recognised push did.
 *
 * - `Registered` / `Unsupported` / `Refused` — the Background Sync
 *   registration's outcome (`action: "backgroundSync"`, the default).
 * - `Pulled` / `PullFailed` — the engine pulled, or the pull failed and the
 *   next connectivity signal pulls instead (`action: "pull"`).
 * - `IdentityChanged` — the replica is not stamped for whoever is signed in
 *   now, so nothing was done.
 */
export type PokeOutcome =
  | BackgroundSync.RegisterOutcome
  | "Pulled"
  | "PullFailed"
  | "IdentityChanged";

/** Options for {@link listen}. */
export interface ListenOptions {
  /**
   * **Required.** Who is signed in now, as `BackgroundSync.listen` takes it:
   * a recognised push acts only if the replica's stamp equals it exactly.
   * An app with no sign-in passes `BackgroundSync.identityUnchecked`.
   */
  readonly identity: BackgroundSync.IdentitySource;
  /**
   * What a recognised push does: `"backgroundSync"` (the default) registers the
   * library's sync tag; `"pull"` pulls at once.
   */
  readonly action?: "backgroundSync" | "pull";
  /** The sync tag to register; defaults to `BackgroundSync.defaultTag`. */
  readonly tag?: string;
  /** The worker's global scope. Defaults to `globalThis` (`self` in a worker). */
  readonly scope?: PushScope;
  /**
   * How long a recognised push waits for a host to attach an engine. Defaults
   * to `BackgroundSync.defaultReadyTimeout`.
   */
  readonly readyTimeout?: Duration.Input;
}

/** The `push` listener {@link listen} installs; a host attaches its engine with {@link Listener.serve}. */
export interface Listener {
  /**
   * Attach `engine` for the scope's lifetime, which `ServiceWorkerHost.start`
   * does when given the listener as `pushPoke`. A push that arrived before
   * then waits for it, up to the ready timeout.
   */
  readonly serve: (engine: ClientEngine.ClientEngine) => Effect.Effect<void, never, Scope.Scope>;
}

/** Whether a push is the library's poke; a push whose data cannot be read as text is not. */
const isLibraryPoke = (event: PushEvent): boolean => {
  const data = event.data;
  if (!P.hasProperty(data, "text") || !P.isFunction(data.text)) return false;
  const text = data.text;
  return Result.match(
    Result.try(() => String(text.call(data))),
    { onSuccess: Marker.isPoke, onFailure: () => false }
  );
};

/** An attached host: its engine, and a runner over its services (logger, tracer). */
interface Attached {
  readonly engine: ClientEngine.ClientEngine;
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/**
 * Install the `push` listener on the worker's scope, synchronously at the top
 * level of the worker script.
 *
 * ```ts
 * // service-worker.ts, top level
 * const backgroundSync = BackgroundSync.listen({ identity: currentFingerprint });
 * const pushPoke = PushPoke.listen({ identity: currentFingerprint });
 * // ... once the engine's layers are built:
 * yield* ServiceWorkerHost.start({ backgroundSync, pushPoke, registry, nodes });
 * ```
 */
export const listen = (options: ListenOptions): Listener => {
  const scope: Partial<PushScope> = options.scope ?? globalThis;
  const tag = options.tag ?? BackgroundSync.defaultTag;
  const readyTimeout = options.readyTimeout ?? BackgroundSync.defaultReadyTimeout;
  const timeoutMillis = Duration.toMillis(Duration.fromInputUnsafe(readyTimeout));
  // The attached host, and the pushes waiting for one. Plain state: the event
  // listener must decide synchronously, and runs nothing until a host brings
  // its services.
  let attached: Option.Option<Attached> = Option.none();
  let waiting: Array<(host: Attached) => void> = [];

  // The identity check of `BackgroundSync.flush`: an exact match, or nothing.
  const sameIdentity = (engine: ClientEngine.ClientEngine): Effect.Effect<boolean> =>
    options.identity === BackgroundSync.identityUnchecked
      ? Effect.succeed(true)
      : Effect.all(
          [options.identity, engine.identity.pipe(Effect.orElseSucceed(() => undefined))],
          { concurrency: 1 }
        ).pipe(Effect.map(([current, stamped]) => current !== undefined && stamped === current));

  const act = (engine: ClientEngine.ClientEngine): Effect.Effect<PokeOutcome> =>
    Effect.gen(function* () {
      if (!(yield* sameIdentity(engine))) {
        yield* Effect.logDebug(
          "Push-poke skipped: the replica is not stamped for the current identity"
        );
        return "IdentityChanged" as const;
      }
      if (options.action === "pull") {
        return yield* engine.pull.pipe(
          Effect.as("Pulled" as const),
          Effect.catch((error) =>
            Effect.logDebug(
              "Push-poke pull failed; the next connectivity signal pulls",
              error
            ).pipe(Effect.as("PullFailed" as const))
          )
        );
      }
      return yield* BackgroundSync.register({
        tag,
        registration: Effect.sync(() => scope.registration),
      });
    });

  // Act through the attached host, or wait for one up to the ready timeout.
  const handle = (): Promise<PokeOutcome | "HostNotReady"> =>
    Option.match(attached, {
      onSome: (host) => host.run(act(host.engine)),
      onNone: () =>
        new Promise<PokeOutcome | "HostNotReady">((resolve) => {
          const proceed = (host: Attached) => {
            clearTimeout(timer);
            resolve(host.run(act(host.engine)));
          };
          const timer = setTimeout(() => {
            waiting = waiting.filter((other) => other !== proceed);
            resolve("HostNotReady");
          }, timeoutMillis);
          waiting = [...waiting, proceed];
        }),
    });

  const listener = (event: PushEvent): void => {
    // Not the library's push: leave it to the app's own handler.
    if (!isLibraryPoke(event)) return;
    event.waitUntil(handle());
  };
  scope.addEventListener?.("push", listener);

  const serve: Listener["serve"] = (engine) =>
    Effect.gen(function* () {
      const host: Attached = { engine, run: Effect.runPromiseWith(yield* Effect.context<never>()) };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          attached = Option.some(host);
          const ready = waiting;
          waiting = [];
          ready.forEach((proceed) => proceed(host));
        }),
        () =>
          Effect.sync(() => {
            // Detach only ourselves: a newer host may already have attached.
            if (Option.isSome(attached) && attached.value === host) attached = Option.none();
          })
      );
    });

  return { serve };
};
