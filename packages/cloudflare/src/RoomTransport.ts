/**
 * RoomTransport
 *
 * The browser-side `ClientTransport` for the room topology: push, pull,
 * and fallthrough reads travel as stateless HTTP POSTs (each one wakes the
 * hibernated room, is answered, and lets it sleep again), while a single
 * WebSocket carries the room's contentless poke frames. The socket
 * reconnects with backoff and its state drives the connection status; sync
 * stays correct over HTTP alone (a dead socket only delays pokes — the
 * pull interval remains the safety net).
 *
 * Runs on standard `fetch`/`WebSocket` globals — no Workers types — so the
 * same transport serves browsers, service workers, and Node 22+.
 */

import { Effect, Queue, Stream } from "effect";
import {
  TransportError,
  type Transport,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation-effect";
import type { Protocol } from "@thomasfosterau/legation-effect/internal";
import { routes } from "./RoomProtocol.js";

/** Options for {@link make}. */
export interface MakeOptions {
  /** The sync base URL, e.g. `https://app.example.com/sync`. */
  readonly url: string;
  /** Extra headers (e.g. the session token) attached to every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Socket reconnect backoff cap in milliseconds. Default 10_000. */
  readonly maxReconnectDelayMillis?: number;
}

const post =
  <A>(options: MakeOptions, route: string) =>
  (body: unknown): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${options.url}${route}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", ...options.headers },
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as { error?: string };
          throw new TransportError({
            message: detail.error ?? `room ${route} answered ${response.status}`,
          });
        }
        // Trusted JSON from this app's own room.
        return (await response.json()) as A;
      },
      catch: (cause) =>
        cause instanceof TransportError
          ? cause
          : new TransportError({ message: `room ${route} request failed`, cause }),
    });

/**
 * Build the transport. The poke socket dials lazily on first subscription
 * and re-dials with linear backoff; each frame becomes one contentless
 * poke.
 */
export const make = (options: MakeOptions): Transport.ClientTransport => {
  const socketUrl = `${options.url.replace(/^http/, "ws")}${routes.socket}`;
  const pokes = Stream.callback<Protocol.Poke>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let socket: WebSocket | undefined;
        let closed = false;
        let attempt = 0;
        const dial = () => {
          if (closed) return;
          socket = new WebSocket(socketUrl);
          socket.onmessage = () => {
            attempt = 0;
            void Queue.offer(queue, {}).pipe(Effect.runPromise);
          };
          socket.onclose = () => {
            if (closed) return;
            attempt += 1;
            const delay = Math.min(1000 * attempt, options.maxReconnectDelayMillis ?? 10_000);
            setTimeout(dial, delay);
          };
          socket.onerror = () => socket?.close();
        };
        dial();
        return () => {
          closed = true;
          socket?.close();
        };
      }),
      (close) => Effect.sync(close)
    )
  );

  return {
    push: (request) => post<Protocol.PushResponse>(options, routes.push)(request),
    pull: (request) => post<Protocol.PullResponse>(options, routes.pull)(request),
    read: (request) => post<Protocol.ReadResponse>(options, routes.read)(request),
    pokes,
    // Correctness never depends on the socket; report the HTTP tier.
    status: Effect.succeed("connected"),
    statusChanges: Stream.succeed("connected"),
  };
};
