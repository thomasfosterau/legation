/**
 * WebSocketServer
 *
 * The Node-runtime server-side WebSocket transport. It accepts WebSocket
 * connections via the `ws` npm package and exposes each connected client as a
 * core `Transport.ServerConnection`, ready to be fed into a `SyncHub`.
 *
 * Wire format: **each WebSocket text message is exactly one JSON-encoded
 * protocol message.** Incoming frames are parsed with `JSON.parse` into a
 * `ClientMessage`; outgoing `ServerMessage`s are serialized with
 * `JSON.stringify`. The matching browser transport
 * (`@thomasfosterau/effect-sync-browser`) speaks the same wire format.
 *
 * Two entry points are provided:
 *
 * - {@link make} starts a server and hands back a stream of
 *   `ServerConnection`s for you to wire up yourself.
 * - {@link serve} starts a server and feeds every incoming connection into the
 *   `SyncHub` in the background, returning the bound port.
 *
 * Both are scoped: closing the surrounding scope shuts the server down and
 * terminates every live client connection.
 */

import { Deferred, Effect, Queue, Scope, Stream } from "effect";
import { TransportError, type StoreError } from "@thomasfosterau/effect-sync-core";
import { Protocol, SyncHub, type Transport } from "@thomasfosterau/effect-sync-core";
import { WebSocketServer as WsServer, type WebSocket as WsSocket } from "ws";

/** The network address a bound server resolves to (mirrors `ws`'s shape). */
interface BoundAddress {
  readonly address: string;
  readonly port: number;
}

/**
 * Options for starting a WebSocket server.
 */
export interface WebSocketServerOptions {
  /** Port to listen on. Use 0 for an ephemeral port. */
  readonly port: number;
  /** Host to bind. Default "0.0.0.0". */
  readonly host?: string | undefined;
}

/**
 * A running WebSocket server exposing incoming clients as core
 * `ServerConnection`s.
 */
export interface SyncWebSocketServer {
  /** The address the server is bound to (resolved port for port 0). */
  readonly address: Effect.Effect<{ readonly port: number; readonly host: string }>;
  /** Stream of incoming client connections. */
  readonly connections: Stream.Stream<Transport.ServerConnection, TransportError>;
  /** Close the server and all connections. */
  readonly shutdown: Effect.Effect<void>;
}

let sessionCounter = 0;

/**
 * Wrap a single `ws` socket as a core `ServerConnection`.
 *
 * The socket's lifetime events drive a per-connection queue of incoming
 * `ClientMessage`s: each text frame is parsed and offered to the queue; a
 * "close" or "error" event shuts the queue down (ending the `messages`
 * stream); unparseable frames are skipped. Because these handlers run outside
 * of the Effect runtime, the queue is driven with the `*Unsafe` operations.
 */
const makeServerConnection = (socket: WsSocket): Effect.Effect<Transport.ServerConnection> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<Protocol.ClientMessage>();

    sessionCounter += 1;
    const sessionId = `ws-${sessionCounter}`;

    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const text = Array.isArray(data)
          ? Buffer.concat(data as ReadonlyArray<Buffer>).toString("utf8")
          : String(data);
        const message = JSON.parse(text) as Protocol.ClientMessage;
        Queue.offerUnsafe(inbound, message);
      } catch {
        // Skip frames that are not valid JSON protocol messages.
      }
    });
    socket.on("close", () => {
      Effect.runFork(Queue.shutdown(inbound));
    });
    socket.on("error", () => {
      Effect.runFork(Queue.shutdown(inbound));
    });

    const send = (message: Protocol.ServerMessage): Effect.Effect<void, TransportError> =>
      Effect.callback<void, TransportError>((resume) => {
        socket.send(JSON.stringify(message), (error) => {
          resume(
            error === undefined || error === null
              ? Effect.void
              : Effect.fail(new TransportError({ message: "WebSocket send failed", cause: error }))
          );
        });
      });

    const close: Effect.Effect<void> = Effect.sync(() => {
      socket.terminate();
    }).pipe(Effect.andThen(Effect.asVoid(Queue.shutdown(inbound))));

    return {
      sessionId,
      send,
      messages: Stream.fromQueue(inbound),
      close,
    } satisfies Transport.ServerConnection;
  });

/**
 * Start a WebSocket server (scoped: closing the scope shuts it down).
 *
 * Binds the `ws` server, resolves the actual bound port (important for
 * `port: 0`), and exposes incoming connections as a stream. Each accepted
 * socket is wrapped as a `ServerConnection` and offered to an unbounded queue
 * backing the `connections` stream.
 */
export const make = (
  options: WebSocketServerOptions
): Effect.Effect<SyncWebSocketServer, TransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const host = options.host ?? "0.0.0.0";
    const connectionQueue = yield* Queue.unbounded<Transport.ServerConnection>();
    const listening = yield* Deferred.make<BoundAddress, TransportError>();

    const wss = yield* Effect.acquireRelease(
      Effect.sync(() => new WsServer({ port: options.port, host })),
      (server) =>
        Effect.sync(() => {
          for (const client of server.clients) {
            client.terminate();
          }
          server.close();
        }).pipe(Effect.andThen(Effect.asVoid(Queue.shutdown(connectionQueue))))
    );

    wss.on("listening", () => {
      const address = wss.address();
      if (typeof address === "object" && address !== null) {
        Effect.runFork(Deferred.succeed(listening, address));
      } else {
        Effect.runFork(
          Deferred.fail(
            listening,
            new TransportError({ message: "WebSocket server bound to a non-network address" })
          )
        );
      }
    });
    wss.on("error", (error) => {
      Effect.runFork(
        Deferred.fail(
          listening,
          new TransportError({ message: "WebSocket server failed to start", cause: error })
        )
      );
    });
    wss.on("connection", (socket: WsSocket) => {
      Effect.runFork(
        Effect.flatMap(makeServerConnection(socket), (connection) =>
          Queue.offer(connectionQueue, connection)
        )
      );
    });

    const bound = yield* Deferred.await(listening);

    const address: Effect.Effect<{ readonly port: number; readonly host: string }> = Effect.sync(
      () => ({ port: bound.port, host: bound.address })
    );

    const shutdown: Effect.Effect<void> = Effect.sync(() => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
    }).pipe(Effect.andThen(Effect.asVoid(Queue.shutdown(connectionQueue))));

    return {
      address,
      connections: Stream.fromQueue(connectionQueue),
      shutdown,
    } satisfies SyncWebSocketServer;
  });

/**
 * The full server: start a WebSocket server and feed every incoming
 * connection into the `SyncHub`.
 *
 * Each connection handler is forked into the scope so a single slow or stuck
 * client cannot block delivery to the others, and the accept loop itself is
 * forked so `serve` returns the bound port promptly. Everything runs until the
 * surrounding scope closes.
 */
export const serve = (
  options: WebSocketServerOptions
): Effect.Effect<
  { readonly port: number },
  TransportError | StoreError,
  SyncHub.SyncHub | Scope.Scope
> =>
  Effect.gen(function* () {
    const hub = yield* SyncHub.SyncHub;
    const server = yield* make(options);

    // Run each connection handler on its own fiber so connections are
    // independent; ignore failures so one dead client cannot crash the loop.
    yield* Effect.forkScoped(
      Stream.runForEach(server.connections, (connection) =>
        Effect.forkScoped(Effect.ignore(hub.handleConnection(connection)))
      )
    );

    const { port } = yield* server.address;
    return { port };
  });
