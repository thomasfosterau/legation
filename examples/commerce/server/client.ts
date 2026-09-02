/**
 * The SvelteKit process's typed client for the sync server's JSON:API,
 * derived from the same `HttpApi` definition the server implements. Loads
 * read through it; form actions write through it — every write lands where
 * the invalidation bus lives. The Kit process attaches the Better-Auth-
 * verified user as the `x-commerce-user` header (the inter-process trust
 * boundary; see server/jsonapi.ts).
 */
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { api } from "./jsonapi.js";

export const SYNC_ORIGIN =
  process.env.SYNC_ORIGIN ?? `http://localhost:${process.env.SYNC_PORT ?? 3100}`;

/** A JSON:API client acting as `userId` (or anonymously when omitted). */
export const makeApiClient = (userId?: string) =>
  HttpApiClient.make(api, {
    baseUrl: SYNC_ORIGIN,
    transformClient: (client) =>
      userId === undefined
        ? client
        : client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("x-commerce-user", userId))
          ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type CommerceApi = Effect.Success<ReturnType<typeof makeApiClient>>;

/**
 * `Effect.runPromise` for typed client calls. effect-jsonapi 0.12's endpoint
 * declarations intersect the `:id` params struct with `Schema.Struct.Fields`,
 * which leaks `unknown` into the requirements of `get`/`delete` calls even
 * though the client already provides everything it needs (the `list` and
 * `create` calls are unaffected). The runtime carries nothing, so narrow the
 * requirements here instead of at every call site.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E>);

// One client per identity per process, built lazily on first use — request
// handling looks the client up instead of carrying it in `locals`.
const clients = new Map<string, CommerceApi>();

/** The process-wide JSON:API client acting as `userId` (or anonymously). */
export const apiFor = (userId?: string): Effect.Effect<CommerceApi> =>
  Effect.suspend(() => {
    const key = userId ?? "";
    const cached = clients.get(key);
    if (cached !== undefined) return Effect.succeed(cached);
    return makeApiClient(userId).pipe(
      Effect.tap((client) => Effect.sync(() => clients.set(key, client)))
    );
  });
