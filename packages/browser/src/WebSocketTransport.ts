/**
 * WebSocketTransport
 *
 * A client-side `ClientTransport` (from `@thomasfosterau/effect-sync-core`)
 * implemented over Effect's own `Socket` abstraction
 * (`effect/unstable/socket/Socket`), which wraps the platform `WebSocket`
 * global. It works in browsers and in Node 22+, which ships a global
 * `WebSocket` client.
 *
 * Wire format: every WebSocket **text** frame is exactly one JSON-encoded
 * protocol message. Outgoing `ClientMessage`s are sent with `JSON.stringify`;
 * incoming frames are schema-validated by `ProtocolSchema.parseServerMessage`
 * and surfaced as `ServerMessage`s. Frames that fail validation are logged and
 * skipped rather than tearing the socket down. This matches the framing used by
 * the server runtime in `@thomasfosterau/effect-sync-node`.
 *
 * The transport maintains a single logical connection. When `reconnect` is
 * enabled (the default) it transparently re-dials with exponential backoff
 * after the socket closes, resetting the backoff once a connection is
 * re-established. Closing the owning scope closes the socket and shuts the
 * incoming-message queue down.
 *
 * Bridging is done the Effect-native way: `Socket.runString` runs an
 * Effect-returning handler for every text frame (no `runFork` inside event
 * callbacks), and the scoped `Socket.writer` is acquired once for sending.
 */

import { Duration, Effect, Layer, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { Socket } from "effect/unstable/socket";
import { ProtocolSchema, Transport, TransportError } from "@thomasfosterau/effect-sync-core";
import type { Protocol } from "@thomasfosterau/effect-sync-core";

type ClientMessage = Protocol.ClientMessage;
type ServerMessage = Protocol.ServerMessage;

/**
 * Options for {@link make} / {@link layer}.
 */
export interface WebSocketTransportOptions {
  /** The `ws://` or `wss://` URL of the sync server. */
  readonly url: string;
  /** Auto-reconnect with exponential backoff when the socket closes. Default: `true`. */
  readonly reconnect?: boolean | undefined;
  /** Base reconnect delay. Default: 250 millis. */
  readonly reconnectBaseDelay?: Duration.Input | undefined;
  /** Max reconnect delay. Default: 10 seconds. */
  readonly reconnectMaxDelay?: Duration.Input | undefined;
  /** Provide a custom `WebSocket` constructor (for tests / non-global environments). */
  readonly webSocketConstructor?: ((url: string) => WebSocket) | undefined;
}

/**
 * Build a `ClientTransport` connected to a sync server over WebSocket.
 *
 * Scoped: closing the scope closes the underlying socket, stops the
 * connection loop, and shuts the incoming-message queue down.
 *
 * If `send` is called while the socket is not connected it fails with a
 * `TransportError` (messages are not buffered).
 */
export const make = (
  options: WebSocketTransportOptions
): Effect.Effect<Transport.ClientTransport, TransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const reconnect = options.reconnect ?? true;
    const baseDelay = Duration.toMillis(options.reconnectBaseDelay ?? Duration.millis(250));
    const maxDelay = Duration.toMillis(options.reconnectMaxDelay ?? Duration.seconds(10));

    const queue = yield* Effect.acquireRelease(Queue.unbounded<ServerMessage>(), (q) =>
      Effect.asVoid(Queue.shutdown(q))
    );
    const status = yield* SubscriptionRef.make<Transport.ConnectionStatus>("connecting");
    // The currently-acquired socket writer, exposed to `send`. `null` whenever
    // there is no open socket.
    const writerRef = yield* Ref.make<
      ((chunk: string) => Effect.Effect<void, Socket.SocketError>) | null
    >(null);

    // Provide the WebSocketConstructor service: the supplied custom constructor
    // (wrapped to ignore the optional `protocols` arg) or the global one.
    const constructorLayer =
      options.webSocketConstructor === undefined
        ? Socket.layerWebSocketConstructorGlobal
        : Layer.succeed(Socket.WebSocketConstructor, (url: string) =>
            options.webSocketConstructor!(url)
          );

    // Run a single connection attempt to completion. Acquires a socket, wires
    // its read loop into the message queue and its writer into `writerRef`, and
    // marks the status `connected` once the socket opens. Resolves with `true`
    // if the socket ever opened, `false` if it failed before opening. Returns
    // when the socket closes or errors.
    const connectOnce = Effect.gen(function* () {
      const opened = yield* Ref.make(false);
      const socket = yield* Socket.makeWebSocket(options.url);

      const onOpen = Ref.set(opened, true).pipe(
        Effect.andThen(SubscriptionRef.set(status, "connected"))
      );

      // Acquire the scoped writer for the lifetime of this connection.
      const run = Effect.gen(function* () {
        const writer = yield* socket.writer;
        yield* Ref.set(writerRef, writer);

        yield* socket.runString(
          (text) =>
            ProtocolSchema.parseServerMessage(text).pipe(
              Effect.flatMap((message) => Effect.sync(() => Queue.offerUnsafe(queue, message))),
              Effect.catchTag("ProtocolError", (error) =>
                Effect.logWarning("Skipping malformed server frame", error)
              )
            ),
          { onOpen }
        );
      });

      // Always drop the writer reference when this connection ends, regardless
      // of how `run` exits.
      yield* Effect.ensuring(
        Effect.scoped(run),
        Ref.set(writerRef, null).pipe(Effect.andThen(SubscriptionRef.set(status, "disconnected")))
      );

      return yield* Ref.get(opened);
    }).pipe(Effect.provide(constructorLayer));

    // Drive (re)connection. `attempt` tracks the backoff exponent; it is reset
    // to 0 after every successful connection. SocketError from a failed dial or
    // a close is caught so the loop can re-dial.
    const loop = Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        yield* SubscriptionRef.set(status, "connecting");

        const opened = yield* connectOnce.pipe(
          Effect.catchTag("SocketError", () => Effect.succeed(false))
        );
        // If we successfully opened during the attempt, reset backoff.
        if (opened) attempt = 0;

        if (!reconnect) {
          yield* SubscriptionRef.set(status, "disconnected");
          return;
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        attempt += 1;
        yield* Effect.sleep(Duration.millis(delay));
      }
    });

    yield* Effect.forkScoped(loop);

    const transport: Transport.ClientTransport = {
      send: (message: ClientMessage) =>
        Effect.gen(function* () {
          const writer = yield* Ref.get(writerRef);
          if (writer === null) {
            return yield* new TransportError({
              message: "WebSocket is not open; cannot send message",
            });
          }
          yield* writer(JSON.stringify(message)).pipe(
            Effect.mapError(
              (cause) =>
                new TransportError({ message: "Failed to send message over WebSocket", cause })
            )
          );
        }),
      messages: Stream.fromQueue(queue),
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status),
    };

    return transport;
  });

/**
 * A `Layer` providing core's `ClientTransport` service backed by a WebSocket.
 *
 * The connection loop and socket are owned by the layer's scope and torn down
 * when the layer is released.
 */
export const layer = (
  options: WebSocketTransportOptions
): Layer.Layer<Transport.ClientTransport, TransportError> =>
  Layer.effect(Transport.ClientTransport)(make(options));
