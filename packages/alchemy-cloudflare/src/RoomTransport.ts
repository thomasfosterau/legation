/**
 * RoomTransport
 *
 * The browser-side `ClientTransport` for the room topology: push, pull,
 * and fallthrough reads travel as stateless HTTP POSTs (any room instance
 * can answer one, a freshly constructed one included), while a single
 * WebSocket carries the room's contentless poke frames. The socket
 * reconnects with backoff, and `status` follows it, so a UI can show live
 * updates as degraded; sync stays correct over HTTP alone (a dead socket
 * only delays pokes — the pull interval remains the safety net).
 *
 * Runs on Effect's Fetch `HttpClient` and `effect/socket` over the standard
 * `WebSocket` global — no Workers types — so the same transport serves
 * browsers, service workers, and Node 22+. Requests carry no
 * trace-propagation headers, so a cross-origin room needs no extra CORS
 * allowance.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";
import { TransportError, type Transport } from "@thomasfosterau/legation";
import { Protocol } from "@thomasfosterau/legation/internal";
import { post } from "./internal/JsonPost.js";
import { routes } from "./RoomProtocol.js";

/** Options for {@link make}. */
export interface MakeOptions {
  /** The sync base URL, e.g. `https://app.example.com/sync`. */
  readonly url: string;
  /** Extra headers (e.g. the session token) attached to every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Socket reconnect backoff cap in milliseconds, for the default
   * {@link reconnect} schedule. Default 10_000. Ignored when `reconnect` is set.
   */
  readonly maxReconnectDelayMillis?: number;
  /**
   * When to re-dial the poke socket after it closes or fails to open. It
   * restarts once a frame arrives on the new socket, and is fed the socket's
   * `SocketError`. Defaults to {@link defaultReconnect} with
   * `maxReconnectDelayMillis`; a schedule that ends stops re-dialling, and the
   * poke stream fails with a `TransportError`.
   */
  readonly reconnect?: Schedule.Schedule<unknown, Socket.SocketError>;
}

/**
 * The default reconnect schedule: linear backoff, one second more per failed
 * attempt (1 s, 2 s, 3 s, …), capped at `maxDelay`, forever.
 */
export const defaultReconnect = (
  maxDelay: Duration.Input = Duration.seconds(10)
): Schedule.Schedule<number> => {
  const cap = Duration.fromInputUnsafe(maxDelay);
  return Schedule.spaced(Duration.seconds(1)).pipe(
    Schedule.modifyDelay(({ output }) =>
      Effect.succeed(Duration.min(Duration.seconds(output + 1), cap))
    )
  );
};

/**
 * Build the transport. The poke socket dials lazily on first subscription
 * and re-dials on the `reconnect` schedule; each frame becomes one
 * contentless poke. `status` follows the socket: `"connecting"` until it
 * opens and while it re-dials, `"connected"` while it is open, and
 * `"disconnected"` once the `reconnect` schedule ends. Push, pull and read
 * never wait on it, so a socket outage only delays pokes; each re-open emits
 * `"connected"`, which starts the sync loop's push and pull.
 */
export const make = (options: MakeOptions): Transport.ClientTransport => {
  const target = { base: options.url, headers: options.headers ?? {}, label: "room" };
  const socketUrl = `${options.url.replace(/^http/, "ws")}${routes.socket}`;
  const reconnect =
    options.reconnect ??
    defaultReconnect(Duration.millis(options.maxReconnectDelayMillis ?? 10_000));

  // The socket's status, made on first use so `make` stays a plain function. The first
  // `SubscriptionRef` made wins, so every reader and the socket share one.
  let made = Option.none<SubscriptionRef.SubscriptionRef<Transport.ConnectionStatus>>();
  const statusRef = Effect.suspend(() =>
    Option.match(made, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.map(SubscriptionRef.make<Transport.ConnectionStatus>("connecting"), (ref) => {
          if (Option.isNone(made)) made = Option.some(ref);
          return Option.getOrElse(made, () => ref);
        }),
    })
  );
  const setStatus = (next: Transport.ConnectionStatus) =>
    Effect.flatMap(statusRef, (ref) => SubscriptionRef.set(ref, next));

  // One connection per run of the stream: the socket opens when the stream
  // starts (acquiring its reader waits for `open`) and closes with its scope.
  // A close or a failed open fails the run, and `Stream.retry` dials again on
  // the schedule. A `WebSocketConstructor` in the context (a test's fake)
  // replaces the global one.
  const connection = Stream.unwrap(
    Effect.gen(function* () {
      const construct = yield* Effect.serviceOption(Socket.WebSocketConstructor);
      const socket = yield* Socket.makeWebSocket(socketUrl).pipe(
        Option.match(construct, {
          onNone: () => Effect.provide(Socket.layerWebSocketConstructorGlobal),
          onSome: (constructor) => Effect.provideService(Socket.WebSocketConstructor, constructor),
        })
      );
      const reader = yield* socket.reader;
      yield* setStatus("connected");
      return Stream.fromPull(Effect.succeed(reader.pull));
    })
  ).pipe(Stream.ensuring(setStatus("connecting")));

  const pokes: Stream.Stream<Protocol.Poke, TransportError> = connection.pipe(
    Stream.map((): Protocol.Poke => ({})),
    Stream.retry(reconnect),
    Stream.tapError(() => setStatus("disconnected")),
    Stream.mapError((cause) => new TransportError({ message: "room poke socket failed", cause }))
  );

  return {
    push: post(target, routes.push, Protocol.PushResponse),
    pull: post(target, routes.pull, Protocol.PullResponse),
    read: post(target, routes.read, Protocol.ReadResponse),
    pokes,
    status: Effect.flatMap(statusRef, SubscriptionRef.get),
    statusChanges: Stream.unwrap(Effect.map(statusRef, SubscriptionRef.changes)).pipe(
      Stream.changesWith((a, b) => a === b)
    ),
  };
};
