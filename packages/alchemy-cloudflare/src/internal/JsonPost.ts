/**
 * The JSON POST both transports send their protocol requests as, on Effect's Fetch `HttpClient`.
 * Private: `RoomTransport` posts over the network and `BindingTransport` through a service
 * binding's `fetch`.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TransportError, type VersionNotSupportedError } from "@thomasfosterau/legation";

/** Where and how {@link post} sends. */
export interface PostTarget {
  /** The sync base URL each route is appended to, without a trailing slash. */
  readonly base: string;
  /** The headers every request carries. */
  readonly headers: Readonly<Record<string, string>>;
  /** Names the carrier in error messages, e.g. `"room"`. */
  readonly label: string;
  /**
   * The fetch to send with, in place of the context's `FetchHttpClient.Fetch` (the global
   * `fetch` unless a caller provides another).
   */
  readonly fetch?: typeof globalThis.fetch;
}

/** The body a server answers a failed request with (`Room`'s error response). */
const ErrorBody = Schema.Struct({ error: Schema.optional(Schema.String) });
const decodeErrorBody = HttpClientResponse.schemaBodyJson(ErrorBody);

/** The Fetch-backed client, built per request so the transports stay requirement-free. */
const fetchClient = Effect.map(Layer.build(FetchHttpClient.layer), (built) =>
  Context.get(built, HttpClient.HttpClient)
);

/**
 * POST a JSON body to `route` and decode the answer with `response`. A non-2xx answer fails with
 * the server's stated `error`, or one naming the route and status; an answer that is not
 * `response` fails as "answer is invalid", and anything else (the send) as "request failed",
 * each a `TransportError` naming the route.
 */
export const post = <A, I>(target: PostTarget, route: string, response: Schema.Codec<A, I>) => {
  const decodeResponse = HttpClientResponse.schemaBodyJson(response);
  const failed = (cause: unknown) =>
    new TransportError({ message: `${target.label} ${route} request failed`, cause });
  return (body: unknown): Effect.Effect<A, TransportError | VersionNotSupportedError> => {
    const sent = Effect.gen(function* () {
      const client = yield* fetchClient;
      const request = yield* HttpClientRequest.post(`${target.base}${route}`).pipe(
        HttpClientRequest.setHeaders(target.headers),
        HttpClientRequest.bodyJson(body),
        Effect.mapError(failed)
      );
      const answer = yield* client.execute(request).pipe(Effect.mapError(failed));
      if (answer.status < 200 || answer.status >= 300) {
        const detail = yield* decodeErrorBody(answer).pipe(
          Effect.orElseSucceed((): typeof ErrorBody.Type => ({}))
        );
        return yield* new TransportError({
          message: detail.error ?? `${target.label} ${route} answered ${answer.status}`,
        });
      }
      return yield* decodeResponse(answer).pipe(
        Effect.mapError(
          (cause) =>
            new TransportError({ message: `${target.label} ${route} answer is invalid`, cause })
        )
      );
    }).pipe(
      Effect.scoped,
      // The server is often cross-origin: `b3`/`traceparent` headers would need it to list them
      // in `Access-Control-Allow-Headers`, or the browser's preflight fails, so none are sent.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    );
    return target.fetch === undefined
      ? sent
      : Effect.provideService(sent, FetchHttpClient.Fetch, target.fetch);
  };
};
