/**
 * Transport
 *
 * The customisable carrier seam for protocol messages (CONTEXT.md: "sync
 * transport"). Core defines the service interfaces and an in-memory pair;
 * the RPC-backed implementation (RpcTransport.ts) is the shipped default,
 * and alternative carriers (HttpApi + SSE, BroadcastChannel mirror↔service-
 * worker, bespoke) implement the same interfaces.
 */

import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  PubSub,
  Ref,
  Result,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { TransportError } from "./Errors.js";
import type { VersionNotSupportedError } from "./Errors.js";
import type {
  Poke,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  ReadRequest,
  ReadResponse,
} from "./Protocol.js";

/** Connectivity of a client transport. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** The client side of a sync connection. */
export interface ClientTransport {
  readonly push: (
    request: PushRequest
  ) => Effect.Effect<PushResponse, TransportError | VersionNotSupportedError>;
  readonly pull: (
    request: PullRequest
  ) => Effect.Effect<PullResponse, TransportError | VersionNotSupportedError>;
  /**
   * Point-in-time fallthrough read (ADR-0025). Optional: carriers that
   * don't offer it simply don't serve the third read tier — the Client
   * degrades to answering locally.
   */
  readonly read?: (
    request: ReadRequest
  ) => Effect.Effect<ReadResponse, TransportError | VersionNotSupportedError>;
  /** Pokes from the server; may be empty for pull-only carriers. */
  readonly pokes: Stream.Stream<Poke, TransportError>;
  readonly status: Effect.Effect<ConnectionStatus>;
  /** Emits the current status first, then changes. */
  readonly statusChanges: Stream.Stream<ConnectionStatus>;
}

/** The {@link ClientTransport} service a Client syncs over. */
export const ClientTransport = Context.Service<ClientTransport>(
  "@thomasfosterau/legation-effect/ClientTransport"
);

/**
 * The server side: what a carrier needs from the sync server to answer
 * clients. Implemented by SyncServer; bound by each carrier (RPC handlers,
 * HTTP routes, message listeners).
 */
export interface ServerHandler {
  readonly handlePush: (
    request: PushRequest
  ) => Effect.Effect<PushResponse, TransportError | VersionNotSupportedError>;
  readonly handlePull: (
    request: PullRequest
  ) => Effect.Effect<PullResponse, TransportError | VersionNotSupportedError>;
  /** Point-in-time fallthrough read (ADR-0025): auth-filtered, no CVR. */
  readonly handleRead: (
    request: ReadRequest
  ) => Effect.Effect<ReadResponse, TransportError | VersionNotSupportedError>;
  /** Pokes addressed to one client group. */
  readonly pokes: (clientGroupId: string) => Stream.Stream<Poke>;
}

/** The {@link ServerHandler} service a carrier answers clients with. */
export const ServerHandler = Context.Service<ServerHandler>(
  "@thomasfosterau/legation-effect/ServerHandler"
);

/**
 * An in-memory client transport bound directly to a ServerHandler — the
 * loop-back carrier for tests and same-process client/server setups.
 */
export const makeInMemory = (
  handler: ServerHandler,
  clientGroupId: string
): Effect.Effect<
  ClientTransport & { readonly setStatus: (status: ConnectionStatus) => Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connected");
    return {
      push: (request) => handler.handlePush(request),
      pull: (request) => handler.handlePull(request),
      read: (request) => handler.handleRead(request),
      pokes: handler.pokes(clientGroupId),
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status),
      setStatus: (next) => SubscriptionRef.set(status, next),
    };
  });

/**
 * The no-server transport: every wire call fails with a `TransportError`,
 * pokes never arrive, status is permanently `"disconnected"`. This is
 * `Client.make`'s default when nothing else is wired — a purely local,
 * optimistic Client (the journal retains every intent, so attaching a real
 * transport later pushes the backlog).
 */
export const offline: ClientTransport = {
  push: () => Effect.fail(new TransportError({ message: "offline transport: no server wired" })),
  pull: () => Effect.fail(new TransportError({ message: "offline transport: no server wired" })),
  read: () => Effect.fail(new TransportError({ message: "offline transport: no server wired" })),
  pokes: Stream.empty,
  status: Effect.succeed("disconnected"),
  statusChanges: Stream.succeed("disconnected"),
};

/** Layer wiring the in-memory transport to an in-context ServerHandler. */
export const layerInMemory = (
  clientGroupId: string
): Layer.Layer<ClientTransport, never, ServerHandler> =>
  Layer.effect(ClientTransport)(
    Effect.gen(function* () {
      const handler = yield* ServerHandler;
      return yield* makeInMemory(handler, clientGroupId);
    })
  );

/**
 * Internal helper: a poke hub keyed by client group (used by SyncServer).
 *
 * Delivery guarantee (#44): one `sliding(1)` PubSub per client group, so a
 * poke storm dedupes. A poke is a contentless "pull soon" hint, so an
 * outstanding, not-yet-consumed poke absorbs any number of fresh ones — the
 * sliding strategy replaces the queued poke rather than growing the queue, and
 * N hints in a tick still deliver at most one queued poke per group. Correctness
 * never depends on the poke: a dropped/collapsed poke only delays the next pull
 * (ADR-0008), which is the correctness path.
 *
 * `replay: 1` on each group's hub keeps the reconnect-race behaviour — a late
 * subscriber (a (re)connecting poke stream) still sees the most recent poke,
 * costing at most a redundant pull. `sliding(1)` already gives the
 * late-subscriber-sees-latest property for active buffers; `replay` extends it
 * across the subscribe gap.
 *
 * Hubs are created lazily per group under a lock (single-flight) and all shut
 * down together when the enclosing scope closes.
 */
export const makePokeHub: Effect.Effect<
  {
    readonly publish: (clientGroupId: string, poke: Poke) => Effect.Effect<void>;
    readonly subscribe: (clientGroupId: string) => Stream.Stream<Poke>;
  },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const hubs = yield* Ref.make(new Map<string, PubSub.PubSub<Poke>>());
  const lock = yield* Semaphore.make(1);
  // One finalizer shuts every group's hub down when the scope closes.
  yield* Effect.addFinalizer(() =>
    Ref.get(hubs).pipe(
      Effect.flatMap((map) => Effect.forEach([...map.values()], (hub) => PubSub.shutdown(hub))),
      Effect.asVoid
    )
  );
  // Get-or-create a group's `sliding(1)` hub; the lock makes creation
  // single-flight so concurrent publish/subscribe for a new group share one hub.
  const hubFor = (clientGroupId: string): Effect.Effect<PubSub.PubSub<Poke>> =>
    Semaphore.withPermit(
      lock,
      Effect.gen(function* () {
        const existing = (yield* Ref.get(hubs)).get(clientGroupId);
        if (existing !== undefined) return existing;
        const hub = yield* PubSub.sliding<Poke>({ capacity: 1, replay: 1 });
        yield* Ref.update(hubs, (map) => new Map(map).set(clientGroupId, hub));
        return hub;
      })
    );
  return {
    publish: (clientGroupId, poke) =>
      hubFor(clientGroupId).pipe(Effect.flatMap((hub) => Effect.asVoid(PubSub.publish(hub, poke)))),
    subscribe: (clientGroupId) =>
      Stream.unwrap(hubFor(clientGroupId).pipe(Effect.map((hub) => Stream.fromPubSub(hub)))),
  };
});

/** Only a TransportError signals carrier trouble; version rejections pass through. */
const isTransportError = (error: TransportError | VersionNotSupportedError): boolean =>
  error._tag === "TransportError";

/** A transport wrapped by {@link simulateOffline}, plus the toggle driving it. */
export interface SimulatedOffline {
  /** The wrapped transport: fails push/pull/read while simulated-offline. */
  readonly transport: ClientTransport;
  /** Flip simulated connectivity. */
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  /** Current simulated-offline state. */
  readonly isOffline: Effect.Effect<boolean>;
}

/**
 * Wrap any transport with a simulated-offline gate: while toggled offline,
 * every push/pull/read *fails* with a `TransportError` (as a real network
 * would), so the engine keeps mutations in the journal and its sync loop
 * flushes them on reconnect — exactly the behaviour a devtools "simulated
 * offline" action needs (issue #120), generalising the demo examples'
 * hand-rolled offline-gate transport into reusable substrate.
 *
 * `status`/`statusChanges` report `"disconnected"` while the gate is closed,
 * otherwise defer to the wrapped transport's own reported status — so this
 * composes under {@link withInferredStatus} or over a carrier that already
 * tracks real connectivity.
 */
export const simulateOffline = (
  transport: ClientTransport
): Effect.Effect<SimulatedOffline, never, Scope.Scope> =>
  Effect.gen(function* () {
    const offline = yield* SubscriptionRef.make(false);

    const gate = <A>(
      effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
    ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      SubscriptionRef.get(offline).pipe(
        Effect.flatMap((isOffline) =>
          isOffline ? Effect.fail(new TransportError({ message: "simulated offline" })) : effect
        )
      );

    const status = SubscriptionRef.get(offline).pipe(
      Effect.flatMap(
        (isOffline): Effect.Effect<ConnectionStatus> =>
          isOffline ? Effect.succeed("disconnected") : transport.status
      )
    );

    const statusChanges = Stream.zipLatestWith(
      SubscriptionRef.changes(offline),
      transport.statusChanges,
      (isOffline, real): ConnectionStatus => (isOffline ? "disconnected" : real)
    ).pipe(Stream.changesWith((a, b) => a === b));

    const wrapped: ClientTransport = {
      push: (request) => gate(transport.push(request)),
      pull: (request) => gate(transport.pull(request)),
      ...(transport.read === undefined
        ? {}
        : { read: (request: ReadRequest) => gate(transport.read!(request)) }),
      pokes: transport.pokes,
      status,
      statusChanges,
    };

    return {
      transport: wrapped,
      setOffline: (next) => SubscriptionRef.set(offline, next),
      isOffline: SubscriptionRef.get(offline),
    };
  });

/**
 * Wrap a transport with connectivity inferred from observed behaviour:
 * `"connecting"` until the first push/pull settles, then `"connected"` after
 * each success and `"disconnected"` after each `TransportError`. Carriers
 * that report their own status (the in-memory pair, a status-aware socket)
 * don't need this; the default RPC carrier does — it reports permanently
 * `"connected"` (RpcTransport.ts), so wrap it with this to give the engine's
 * reconnect trigger something real to react to.
 */
export const withInferredStatus = (
  transport: ClientTransport
): Effect.Effect<ClientTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connecting");
    const observe = <A>(
      effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
    ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      effect.pipe(
        Effect.tap(() => SubscriptionRef.set(status, "connected")),
        Effect.tapError((error) =>
          isTransportError(error) ? SubscriptionRef.set(status, "disconnected") : Effect.void
        )
      );
    return {
      push: (request) => observe(transport.push(request)),
      pull: (request) => observe(transport.pull(request)),
      pokes: transport.pokes,
      status: SubscriptionRef.get(status),
      // Dedup consecutive repeats so a burst of successful calls doesn't spam
      // the engine's reconnect trigger with "connected" re-emissions.
      statusChanges: SubscriptionRef.changes(status).pipe(Stream.changesWith((a, b) => a === b)),
    };
  });

/** Options for {@link withFallback}. */
export interface FallbackOptions {
  /**
   * How long a failed primary is sidelined before a call probes it again.
   * Default 30 seconds.
   */
  readonly restoreAfter?: Duration.Input;
  /**
   * Time budget for each primary call. A primary that neither succeeds nor
   * fails within it is interrupted and treated as a `TransportError`:
   * sidelined, with the call falling to the fallback. Without a budget, a
   * carrier that hangs rather than fails stalls sync indefinitely — the
   * fallback never gets a chance. No default: a cold-start pull over a slow
   * link can legitimately be slow, so pick a budget suited to your payloads.
   * (A delivered-but-timed-out push re-sent through the fallback is safe:
   * the server's mutation ledger deduplicates by mutation id.)
   */
  readonly primaryTimeout?: Duration.Input;
}

/**
 * Layer a fallback carrier under a primary one (e.g. plain HTTP under
 * WebSockets): each push/pull tries the primary and falls back on a
 * `TransportError`. After a primary failure the primary is sidelined for
 * `restoreAfter`, so subsequent calls go straight to the fallback until the
 * cooldown elapses and a call probes the primary again.
 *
 * Status is inferred from observed behaviour: `"connected"` while either
 * carrier serves (sync is a progressive enhancement — a working fallback IS
 * connected), `"disconnected"` once a call exhausts both. Pokes from both
 * carriers are merged (they are contentless hints; duplicates cost at most a
 * redundant pull) and a failing primary poke stream is dropped rather than
 * killing the fallback's. A `VersionNotSupportedError` propagates without
 * falling back — it is the server's verdict, not carrier trouble.
 */
export const withFallback = (
  primary: ClientTransport,
  fallback: ClientTransport,
  options?: FallbackOptions
): Effect.Effect<ClientTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const restoreAfterMillis = Duration.toMillis(options?.restoreAfter ?? "30 seconds");
    const primaryTimeout = options?.primaryTimeout;
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connecting");
    const sidelinedUntil = yield* Ref.make(0);

    // A hang is carrier trouble just like a failure: interrupt the primary
    // and surface a TransportError so the sideline-and-fall-back path runs.
    const budgeted = <A>(
      effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
    ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      primaryTimeout === undefined
        ? effect
        : Effect.timeoutOrElse(effect, {
            duration: primaryTimeout,
            orElse: () =>
              Effect.fail(
                new TransportError({
                  message: `primary transport call exceeded ${Duration.format(
                    Duration.fromInputUnsafe(primaryTimeout)
                  )}`,
                })
              ),
          });

    const call = <A>(
      f: (transport: ClientTransport) => Effect.Effect<A, TransportError | VersionNotSupportedError>
    ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if ((yield* Ref.get(sidelinedUntil)) <= now) {
          const first = yield* Effect.result(budgeted(f(primary)));
          if (Result.isSuccess(first)) {
            yield* SubscriptionRef.set(status, "connected");
            return first.success;
          }
          if (!isTransportError(first.failure)) return yield* Effect.fail(first.failure);
          yield* Ref.set(sidelinedUntil, now + restoreAfterMillis);
        }
        const second = yield* Effect.result(f(fallback));
        if (Result.isSuccess(second)) {
          yield* SubscriptionRef.set(status, "connected");
          return second.success;
        }
        if (isTransportError(second.failure)) yield* SubscriptionRef.set(status, "disconnected");
        return yield* Effect.fail(second.failure);
      });

    return {
      push: (request) => call((transport) => transport.push(request)),
      pull: (request) => call((transport) => transport.pull(request)),
      pokes: Stream.merge(
        primary.pokes.pipe(Stream.catchCause(() => Stream.empty)),
        fallback.pokes
      ),
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status).pipe(Stream.changesWith((a, b) => a === b)),
    };
  });
