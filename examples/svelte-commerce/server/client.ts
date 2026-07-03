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
