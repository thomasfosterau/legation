/**
 * The SvelteKit process's typed client for the sync server's `/api` surface,
 * derived from the same `HttpApi` definition the server implements. Writes
 * from the Kit boundary (form actions) go through this client instead of
 * touching SQLite directly, so they land where the invalidation bus lives.
 */
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { api } from "./api.js";

export const SYNC_ORIGIN = process.env.SYNC_ORIGIN ?? `http://localhost:${process.env.SYNC_PORT ?? 3100}`;

export const makeApiClient = HttpApiClient.make(api, { baseUrl: SYNC_ORIGIN }).pipe(
  Effect.provide(FetchHttpClient.layer)
);

export type CommerceApi = Effect.Success<typeof makeApiClient>;
