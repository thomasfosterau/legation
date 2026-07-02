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
  Context,
  Effect,
  Layer,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import type { TransportError } from "./Errors.js";
import type { Poke, PullRequest, PullResponse, PushRequest, PushResponse } from "./Protocol.js";

/** Connectivity of a client transport. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** The client side of a sync connection. */
export interface ClientTransport {
  readonly push: (request: PushRequest) => Effect.Effect<PushResponse, TransportError>;
  readonly pull: (request: PullRequest) => Effect.Effect<PullResponse, TransportError>;
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
  readonly handlePush: (request: PushRequest) => Effect.Effect<PushResponse, TransportError>;
  readonly handlePull: (request: PullRequest) => Effect.Effect<PullResponse, TransportError>;
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
