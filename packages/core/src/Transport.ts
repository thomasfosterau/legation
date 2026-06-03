/**
 * Transport
 *
 * The connection abstraction between sync clients and sync servers.
 *
 * - `ClientTransport` is what a client uses to talk to a server: send
 *   `ClientMessage`s, receive `ServerMessage`s, and observe connectivity.
 * - `ServerConnection` is one connected client as seen by the server:
 *   receive `ClientMessage`s and send `ServerMessage`s back.
 *
 * Implementations can be backed by WebSockets, SSE + HTTP, BroadcastChannel,
 * or anything else that can move JSON. `makeInMemoryPair` provides a
 * loop-back implementation for tests and same-process client/server setups.
 */

import { Context, Effect, Queue, Scope, Stream, SubscriptionRef } from "effect";
import type { TransportError } from "./Errors.js";
import type { ClientMessage, ServerMessage } from "./Protocol.js";

/**
 * Connectivity of a client transport.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * The client side of a sync connection.
 */
export interface ClientTransport {
  /** Send a message to the server. */
  readonly send: (message: ClientMessage) => Effect.Effect<void, TransportError>;
  /** Messages pushed by the server. */
  readonly messages: Stream.Stream<ServerMessage, TransportError>;
  /** Current connection status. */
  readonly status: Effect.Effect<ConnectionStatus>;
  /** Connection status changes (emits the current status first). */
  readonly statusChanges: Stream.Stream<ConnectionStatus>;
}

/**
 * Service key for the client transport.
 */
export const ClientTransport = Context.Service<ClientTransport>(
  "@thomasfosterau/effect-sync-core/ClientTransport"
);

/**
 * One connected client, as seen by the server.
 */
export interface ServerConnection {
  /** Unique id of this connection/session. */
  readonly sessionId: string;
  /** Send a message to this client. */
  readonly send: (message: ServerMessage) => Effect.Effect<void, TransportError>;
  /** Messages sent by this client. */
  readonly messages: Stream.Stream<ClientMessage, TransportError>;
  /** Close the connection. */
  readonly close: Effect.Effect<void>;
}

/**
 * An in-memory connected client/server transport pair.
 */
export interface InMemoryPair {
  readonly client: ClientTransport;
  readonly server: ServerConnection;
  /** Simulate a connectivity change on the client side. */
  readonly setStatus: (status: ConnectionStatus) => Effect.Effect<void>;
}

let pairCounter = 0;

/**
 * Create a connected in-memory client/server transport pair.
 *
 * Used in tests and for same-process sync (e.g. a server-side cache layer
 * subscribing to its own sync hub). Queues are shut down when the scope
 * closes.
 */
export const makeInMemoryPair: Effect.Effect<InMemoryPair, never, Scope.Scope> = Effect.gen(
  function* () {
    const clientToServer = yield* Effect.acquireRelease(Queue.unbounded<ClientMessage>(), (queue) =>
      Effect.asVoid(Queue.shutdown(queue))
    );
    const serverToClient = yield* Effect.acquireRelease(Queue.unbounded<ServerMessage>(), (queue) =>
      Effect.asVoid(Queue.shutdown(queue))
    );
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connected");

    pairCounter += 1;
    const sessionId = `in-memory-${pairCounter}`;

    const client: ClientTransport = {
      send: (message) => Effect.asVoid(Queue.offer(clientToServer, message)),
      messages: Stream.fromQueue(serverToClient),
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status),
    };

    const server: ServerConnection = {
      sessionId,
      send: (message) => Effect.asVoid(Queue.offer(serverToClient, message)),
      messages: Stream.fromQueue(clientToServer),
      close: Effect.gen(function* () {
        yield* SubscriptionRef.set(status, "disconnected");
        yield* Queue.shutdown(clientToServer);
        yield* Queue.shutdown(serverToClient);
      }),
    };

    return {
      client,
      server,
      setStatus: (next) => SubscriptionRef.set(status, next),
    } satisfies InMemoryPair;
  }
);
