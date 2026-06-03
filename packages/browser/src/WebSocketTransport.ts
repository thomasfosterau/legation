/**
 * WebSocketTransport
 *
 * A client-side `ClientTransport` (from `@thomasfosterau/effect-sync-core`)
 * implemented over the platform `WebSocket` global. It works in browsers and
 * in Node 22+, which ships a global `WebSocket` client.
 *
 * Wire format: every WebSocket **text** frame is exactly one JSON-encoded
 * protocol message. Outgoing `ClientMessage`s are sent with
 * `JSON.stringify`; incoming frames are decoded with `JSON.parse` and treated
 * as `ServerMessage`s. This matches the framing used by the server runtime in
 * `@thomasfosterau/effect-sync-node`.
 *
 * The transport maintains a single logical connection. When `reconnect` is
 * enabled (the default) it transparently re-dials with exponential backoff
 * after the socket closes, resetting the backoff once a connection is
 * re-established. Closing the owning scope closes the socket and shuts the
 * incoming-message queue down.
 */

import { Duration, Effect, Layer, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { Transport, TransportError } from "@thomasfosterau/effect-sync-core";
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

// WebSocket.readyState constant; avoids relying on the static on a possibly
// custom constructor.
const WS_OPEN = 1;

/**
 * Build a `ClientTransport` connected to a sync server over WebSocket.
 *
 * Scoped: closing the scope closes the underlying socket, stops the
 * connection loop, and shuts the incoming-message queue down.
 *
 * If `send` is called while the socket is not OPEN it fails with a
 * `TransportError` (messages are not buffered).
 */
export const make = (
  options: WebSocketTransportOptions
): Effect.Effect<Transport.ClientTransport, TransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const reconnect = options.reconnect ?? true;
    const baseDelay = Duration.toMillis(options.reconnectBaseDelay ?? Duration.millis(250));
    const maxDelay = Duration.toMillis(options.reconnectMaxDelay ?? Duration.seconds(10));
    const construct =
      options.webSocketConstructor ?? ((url: string): WebSocket => new WebSocket(url));

    const queue = yield* Effect.acquireRelease(Queue.unbounded<ServerMessage>(), (q) =>
      Effect.asVoid(Queue.shutdown(q))
    );
    const status = yield* SubscriptionRef.make<Transport.ConnectionStatus>("connecting");
    // The currently-open socket, exposed to `send`. `null` whenever there is
    // no OPEN socket.
    const socketRef = yield* Ref.make<WebSocket | null>(null);

    // Run a single connection attempt to completion: resolve with `true` once
    // the socket has been open at least once and then closed/errored, or
    // `false` if it failed before ever opening. Wires the socket's lifecycle
    // events into Effect via the SubscriptionRef and the message queue.
    const connectOnce = Effect.callback<boolean, never>((resume) => {
      let settled = false;
      let opened = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(opened));
      };

      let ws: WebSocket;
      try {
        ws = construct(options.url);
      } catch {
        settle();
        return;
      }

      ws.onopen = (): void => {
        opened = true;
        Effect.runFork(
          Effect.gen(function* () {
            yield* Ref.set(socketRef, ws);
            yield* SubscriptionRef.set(status, "connected");
          })
        );
      };
      ws.onmessage = (event: MessageEvent): void => {
        const data = event.data;
        const text = typeof data === "string" ? data : undefined;
        if (text === undefined) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(text) as ServerMessage;
        } catch {
          // Malformed frame: ignore it rather than tearing down the socket.
          return;
        }
        Effect.runFork(Effect.asVoid(Queue.offer(queue, message)));
      };
      const markDisconnected = Effect.gen(function* () {
        yield* Ref.set(socketRef, null);
        yield* SubscriptionRef.set(status, "disconnected");
      });
      ws.onerror = (): void => {
        Effect.runFork(markDisconnected);
        settle();
      };
      ws.onclose = (): void => {
        Effect.runFork(markDisconnected);
        settle();
      };

      // Finalizer-on-interrupt: close the socket if the surrounding effect is
      // interrupted (e.g. the scope is closing).
      return Effect.sync(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    });

    // Drive (re)connection. `attempt` tracks the backoff exponent; it is reset
    // to 0 after every successful connection.
    const loop = Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        yield* SubscriptionRef.set(status, "connecting");
        const didConnect = yield* connectOnce;
        if (didConnect) attempt = 0;

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
          const ws = yield* Ref.get(socketRef);
          if (ws === null || ws.readyState !== WS_OPEN) {
            return yield* new TransportError({
              message: "WebSocket is not open; cannot send message",
            });
          }
          yield* Effect.try({
            try: () => ws.send(JSON.stringify(message)),
            catch: (cause) =>
              new TransportError({ message: "Failed to send message over WebSocket", cause }),
          });
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
