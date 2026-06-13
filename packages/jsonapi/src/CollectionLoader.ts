/**
 * CollectionLoader
 *
 * The JSON:API package's place in the v2 model (ADR-0008): a *collection
 * loader*. A JSON:API `type` is a collection, each resource's `id` is a row
 * id, and a resource maps to a row value (attributes + resolved
 * relationship references). Loaders read documents into collection rows;
 * they do not own a sync model of their own.
 *
 * This is a read-side adapter. Writes in the v2 engine are named mutators
 * (ADR-0008), not ad-hoc REST calls, so the former conflict-strategy
 * push/pull helpers are gone. To sync a JSON:API upstream, back a `Backend`
 * (or a read-only collection) with `load`/`loadOne` and emit row versions
 * from the upstream's own change token (ETag, `meta.version`, …).
 */

import { Context, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ApiError, ParseError } from "./errors.js";
import { decodeDocument } from "./schema.js";
import type {
  JsonApiDocument,
  JsonApiRequestOptions,
  ResourceIdentifier,
  ResourceObject,
} from "./types.js";

// ─── Row mapping ─────────────────────────────────────────────────────────────

/** A relationship as it lands in a row value: linkage only, no documents. */
export type RelationshipRef =
  | { readonly type: string; readonly id: string }
  | ReadonlyArray<{ readonly type: string; readonly id: string }>
  | null;

/** The value a JSON:API resource takes as a collection row. */
export interface ResourceValue {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly relationships: Record<string, RelationshipRef>;
}

/** A collection row materialized from a resource: (collection, id, value). */
export interface CollectionRow {
  readonly collection: string;
  readonly id: string;
  readonly value: ResourceValue;
}

/** The rows a document yields: its primary data and its compound `included`. */
export interface LoadedRows {
  readonly rows: ReadonlyArray<CollectionRow>;
  readonly included: ReadonlyArray<CollectionRow>;
}

const identifier = (ref: ResourceIdentifier) => ({ type: ref.type, id: ref.id });

/** Map a resource (or bare identifier) to a collection row. */
export const resourceToRow = (resource: ResourceObject | ResourceIdentifier): CollectionRow => {
  const full = resource as ResourceObject;
  const relationships: Record<string, RelationshipRef> = {};
  for (const [name, relationship] of Object.entries(full.relationships ?? {})) {
    if (relationship.data === undefined) continue;
    relationships[name] =
      relationship.data === null
        ? null
        : Array.isArray(relationship.data)
          ? relationship.data.map(identifier)
          : identifier(relationship.data);
  }
  return {
    collection: resource.type,
    id: resource.id,
    value: {
      type: resource.type,
      id: resource.id,
      attributes: full.attributes ?? {},
      relationships,
    },
  };
};

const dataResources = (
  data: JsonApiDocument["data"]
): ReadonlyArray<ResourceObject | ResourceIdentifier> =>
  data === undefined || data === null ? [] : Array.isArray(data) ? data : [data];

/** Map a whole document to its primary rows and its `included` rows. */
export const documentToRows = (document: JsonApiDocument): LoadedRows => ({
  rows: dataResources(document.data).map(resourceToRow),
  included: (document.included ?? []).map(resourceToRow),
});

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The JSON:API endpoint a loader reads from. */
export interface JsonApiSource {
  readonly baseUrl: string;
}

export const JsonApiSource = Context.Service<JsonApiSource>(
  "@thomasfosterau/effect-sync-jsonapi/JsonApiSource"
);

const jsonApiHeaders = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
} as const;

const appendBracketed = (
  params: URLSearchParams,
  prefix: string,
  record: Record<string, string | number | undefined>
): void => {
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) params.append(`${prefix}[${key}]`, value.toString());
  }
};

/** Build the JSON:API query string for `include`/`sort`/`fields`/`filter`/`page`. */
export const buildQueryString = (options?: JsonApiRequestOptions): string => {
  if (options === undefined) return "";
  const params = new URLSearchParams();
  if (options.include) params.append("include", options.include.join(","));
  if (options.sort) params.append("sort", options.sort.join(","));
  if (options.fields) {
    appendBracketed(
      params,
      "fields",
      Object.fromEntries(Object.entries(options.fields).map(([type, f]) => [type, f.join(",")]))
    );
  }
  if (options.filter) appendBracketed(params, "filter", options.filter);
  if (options.page) appendBracketed(params, "page", options.page);
  const query = params.toString();
  return query ? `?${query}` : "";
};

/** Validate a JSON:API response into a document (non-2xx / `errors` → ApiError). */
export const parseResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<JsonApiDocument, ParseError | ApiError | HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
      const errors =
        typeof body === "object" && body !== null && Array.isArray((body as JsonApiDocument).errors)
          ? (body as JsonApiDocument).errors!
          : [];
      return yield* new ApiError({ message: `HTTP ${response.status}`, errors });
    }
    const json = yield* response.json.pipe(
      Effect.mapError((cause) => new ParseError({ message: "Failed to parse JSON body", cause }))
    );
    const document = yield* decodeDocument(json);
    if (document.errors && document.errors.length > 0) {
      return yield* new ApiError({ message: "Document carried errors", errors: document.errors });
    }
    return document;
  });

const get = (url: string) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(jsonApiHeaders));

/** Load a collection (`GET /{type}`) into rows. */
export const load = (
  type: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  LoadedRows,
  ParseError | ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | JsonApiSource
> =>
  Effect.gen(function* () {
    const source = yield* JsonApiSource;
    const client = yield* HttpClient.HttpClient;
    const url = `${source.baseUrl}/${type}${buildQueryString(options)}`;
    const response = yield* Effect.scoped(client.execute(get(url)));
    return documentToRows(yield* parseResponse(response));
  });

/** Load a single resource (`GET /{type}/{id}`); `undefined` if absent. */
export const loadOne = (
  type: string,
  id: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  CollectionRow | undefined,
  ParseError | ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | JsonApiSource
> =>
  Effect.gen(function* () {
    const source = yield* JsonApiSource;
    const client = yield* HttpClient.HttpClient;
    const url = `${source.baseUrl}/${type}/${id}${buildQueryString(options)}`;
    const response = yield* Effect.scoped(client.execute(get(url)));
    return documentToRows(yield* parseResponse(response)).rows[0];
  });
