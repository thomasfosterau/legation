/**
 * Transport
 *
 * The customisable carrier seam for protocol messages (CONTEXT.md: "sync
 * transport"). Core defines the service interfaces and an in-memory pair;
 * the RPC-backed implementation (RpcTransport.ts) is the shipped default,
 * and alternative carriers (HttpApi + SSE, BroadcastChannel tab↔service-
 * worker, bespoke) implement the same interfaces.
 */

import { Context, Effect, Layer, PubSub, Scope, Stream, SubscriptionRef } from "effect";
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

export const ClientTransport = Context.Service<ClientTransport>(
  "@thomasfosterau/effect-sync-core/ClientTransport"
);

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

export const ServerHandler = Context.Service<ServerHandler>(
  "@thomasfosterau/effect-sync-core/ServerHandler"
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

/** Internal helper: a poke hub keyed by client group (used by SyncServer). */
export const makePokeHub: Effect.Effect<
  {
    readonly publish: (clientGroupId: string, poke: Poke) => Effect.Effect<void>;
    readonly subscribe: (clientGroupId: string) => Stream.Stream<Poke>;
  },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const pubsub = yield* Effect.acquireRelease(
    PubSub.unbounded<{ readonly clientGroupId: string; readonly poke: Poke }>(),
    (hub) => PubSub.shutdown(hub)
  );
  return {
    publish: (clientGroupId, poke) =>
      Effect.asVoid(PubSub.publish(pubsub, { clientGroupId, poke })),
    subscribe: (clientGroupId) =>
      Stream.fromPubSub(pubsub).pipe(
        Stream.filter((message) => message.clientGroupId === clientGroupId),
        Stream.map((message) => message.poke)
      ),
  };
});
