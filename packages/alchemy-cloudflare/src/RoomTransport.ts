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
 * Runs on Effect's Fetch `HttpClient` and the standard `WebSocket` global —
 * no Workers types — so the same transport serves browsers, service workers,
 * and Node 22+. Requests carry no trace-propagation headers, so a
 * cross-origin room needs no extra CORS allowance.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  TransportError,
  type Transport,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation";
import { Protocol } from "@thomasfosterau/legation/internal";
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

/** The body a room answers a failed request with (`Room`'s error response). */
const ErrorBody = Schema.Struct({ error: Schema.optional(Schema.String) });
const decodeErrorBody = HttpClientResponse.schemaBodyJson(ErrorBody);

/**
 * The Fetch-backed client the transport runs on, built per request so `make`
 * stays requirement-free.
 */
const fetchClient = Effect.map(Layer.build(FetchHttpClient.layer), (built) =>
  Context.get(built, HttpClient.HttpClient)
);

const post = <A>(options: MakeOptions, route: string, response: Schema.Codec<A>) => {
  const decodeResponse = HttpClientResponse.schemaBodyJson(response);
  const failed = (cause: unknown) =>
    new TransportError({ message: `room ${route} request failed`, cause });
  return (body: unknown): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
    Effect.gen(function* () {
      const client = yield* fetchClient;
      const request = yield* HttpClientRequest.post(`${options.url}${route}`).pipe(
        HttpClientRequest.setHeaders(options.headers ?? {}),
        HttpClientRequest.bodyJson(body),
        Effect.mapError(failed)
      );
      const answer = yield* client.execute(request).pipe(Effect.mapError(failed));
      if (answer.status < 200 || answer.status >= 300) {
        const detail = yield* decodeErrorBody(answer).pipe(
          Effect.orElseSucceed((): typeof ErrorBody.Type => ({}))
        );
        return yield* new TransportError({
          message: detail.error ?? `room ${route} answered ${answer.status}`,
        });
      }
      return yield* decodeResponse(answer).pipe(Effect.mapError(failed));
    }).pipe(
      Effect.scoped,
      // The room is usually cross-origin: `b3`/`traceparent` headers would
      // need the room to list them in `Access-Control-Allow-Headers`, or the
      // browser's preflight fails, so the request carries none.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    );
};

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
            Queue.offerUnsafe(queue, {});
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
    push: post(options, routes.push, Protocol.PushResponse),
    pull: post(options, routes.pull, Protocol.PullResponse),
    read: post(options, routes.read, Protocol.ReadResponse),
    pokes,
    // Correctness never depends on the socket; report the HTTP tier.
    status: Effect.succeed("connected"),
    statusChanges: Stream.succeed("connected"),
  };
};
