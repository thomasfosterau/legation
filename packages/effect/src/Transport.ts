/**
 * Transport
 *
 * The customisable carrier seam for protocol messages (CONTEXT.md: "sync
 * transport"). Core defines the service interfaces and an in-memory pair;
 * the RPC-backed implementation (RpcTransport.ts) is the shipped default,
 * and alternative carriers (HttpApi + SSE, BroadcastChannel tab↔service-
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
import type { TransportError, VersionNotSupportedError } from "./Errors.js";
import type { Poke, PullRequest, PullResponse, PushRequest, PushResponse } from "./Protocol.js";

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
  /** Pokes from the server; may be empty for pull-only carriers. */
  readonly pokes: Stream.Stream<Poke, TransportError>;
  readonly status: Effect.Effect<ConnectionStatus>;
  /** Emits the current status first, then changes. */
  readonly statusChanges: Stream.Stream<ConnectionStatus>;
}

export const ClientTransport = Context.Service<ClientTransport>("@legation/effect/ClientTransport");

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
  /** Pokes addressed to one client group. */
  readonly pokes: (clientGroupId: string) => Stream.Stream<Poke>;
}

export const ServerHandler = Context.Service<ServerHandler>("@legation/effect/ServerHandler");

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
      pokes: handler.pokes(clientGroupId),
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status),
      setStatus: (next) => SubscriptionRef.set(status, next),
    };
  });

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
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connecting");
    const sidelinedUntil = yield* Ref.make(0);

    const call = <A>(
      f: (transport: ClientTransport) => Effect.Effect<A, TransportError | VersionNotSupportedError>
    ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if ((yield* Ref.get(sidelinedUntil)) <= now) {
          const first = yield* Effect.result(f(primary));
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
