/**
 * The SvelteKit process's client for the sync server's JSON:API.
 *
 * Reads go by URL: a load names the declarative read the page will keep
 * live (`productPage`, `productDetail`, `myCartItems`, … from
 * `src/lib/domain.ts`), {@link readUrl} spells it as the read's **canonical**
 * string (`JsonApiQuery.canonical` — one string per plan, ADR-0029 §2), and
 * {@link readCollection} fetches that URL and decodes the collection
 * document with the resource's own schema. The SSR load's URL and the
 * identity the tab later subscribes under are therefore the same string:
 * `GET /jsonapi/products?filter[categoryId]=c-audio&page[limit]=4&sort=id`
 * is the catalog load, the derived handler's read, and the live hook's
 * window (`Client.subscribe(url)`, #159), and a façade serving it from the
 * replica answers the same document (ADR-0029 §6).
 *
 * Writes go through the typed client derived from the same `HttpApi`
 * definition the server implements ({@link apiFor}): form actions post
 * through it, so every write lands where the invalidation bus lives. The
 * Kit process attaches the Better-Auth-verified user as the
 * `x-commerce-user` header on both paths (the inter-process trust boundary;
 * see server/jsonapi.ts).
 */
import { Effect, type Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@legation/effect";
import { readPath } from "../src/lib/reads.js";
import { api } from "./jsonapi.js";

export const SYNC_ORIGIN =
  process.env.SYNC_ORIGIN ?? `http://localhost:${process.env.SYNC_PORT ?? 3100}`;

/** The identity header, when acting as a user. */
const asUser = (userId: string | undefined) =>
  userId === undefined
    ? <A, E, R>(client: HttpClient.HttpClient.With<E, R>) => client
    : HttpClient.mapRequest(HttpClientRequest.setHeader("x-commerce-user", userId));

// ─── Reads: canonical URLs ───────────────────────────────────────────────────

/**
 * The JSON:API URL of a read on the sync server: its canonical string under
 * the api's mount path (`readPath`, `src/lib/reads.ts` — the one spelling
 * the loads, the proxy and the browser share). Throws a `QueryError` for a
 * read the grammar cannot spell (an unknown collection, a field outside the
 * filterable set) — a definition bug in the app's reads, never request
 * state.
 */
export const readUrl = (read: Query.Read): string => `${SYNC_ORIGIN}${readPath(read)}`;

/**
 * `GET` a read's canonical URL as `userId` (or anonymously) and decode the
 * body with the resource's collection document schema (`Product.collection()`)
 * — the shape the pages' `initial` seeds are built from.
 */
export const readCollection = <S extends Schema.Top & { readonly DecodingServices: never }>(
  userId: string | undefined,
  document: S,
  read: Query.Read
): Effect.Effect<S["Type"]> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client
        .pipe(HttpClient.filterStatusOk, asUser(userId))
        .get(readUrl(read), { headers: { accept: MEDIA_TYPE } })
    ),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(document)),
    Effect.provide(FetchHttpClient.layer),
    // A failing read is a broken deployment (the sync server is down, or the
    // contract drifted), not a state the page can render — surface it.
    Effect.orDie
  );

// ─── Writes: the typed client ────────────────────────────────────────────────

/** A JSON:API client acting as `userId` (or anonymously when omitted). */
export const makeApiClient = (userId?: string) =>
  HttpApiClient.make(api, {
    baseUrl: SYNC_ORIGIN,
    transformClient: asUser(userId),
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type CommerceApi = Effect.Success<ReturnType<typeof makeApiClient>>;

/**
 * `Effect.runPromise` for typed client calls. effect-jsonapi's endpoint
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
