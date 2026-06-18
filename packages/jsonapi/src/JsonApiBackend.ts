/**
 * JsonApiBackend
 *
 * An implementation of the core `Backend` contract (ADR-0009) backed by a
 * JSON:API HTTP surface instead of app-owned storage. This is what lets the
 * library "figure out the sync story" from a plain REST API: the sync server
 * (in-process for the client-direct happy path) drives this backend's three
 * operations, and the existing engine supplies journal, overlay, rebase, and
 * CVR diffing on top.
 *
 * Mapping:
 * - `evaluate` lists the collection (`GET /{type}`) and filters/sorts/limits
 *   locally with `Subset.apply`. Pushing predicates into JSON:API `filter`
 *   query params is a later optimization; listing-then-filtering is always
 *   correct.
 * - `getRows` serves row values from the cache `evaluate` populates (the sync
 *   server always evaluates before fetching put rows in the same pull),
 *   falling back to `GET /{type}/{id}`.
 * - `applyMutations` replays each CRUD mutator as its HTTP write
 *   (`POST`/`PATCH`/`DELETE`).
 *
 * **Versioning.** A plain REST API exposes no row-version token, so versions
 * are a content hash of the resource value: the hash changes iff the row
 * changed, which is exactly what CVR diffing needs.
 *
 * **Delivery semantics.** Without a cooperating server there is no
 * server-side mutation-id ledger, so this backend keeps an in-session ledger
 * and provides *at-least-once* application. Make writes idempotent
 * (client-generated ids on create; PATCH/DELETE are naturally idempotent) and
 * retries are safe.
 */

import { Effect, Ref, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Backend, BackendError } from "@thomasfosterau/effect-sync-core";
import { Subset } from "@thomasfosterau/effect-sync-core";
import type { Mutator } from "@thomasfosterau/effect-sync-core";
import { documentToRows, parseResponse, type ResourceValue } from "./CollectionLoader.js";
import type { ResourceMap } from "./Convention.js";
import type { OperationInfo } from "./Derive.js";

export interface JsonApiBackendConfig {
  /** Base URL the resource paths are resolved against (no trailing slash). */
  readonly baseUrl: string;
  readonly resources: ResourceMap;
  /** Mutator definitions, for decoding/validating pushed args. */
  readonly mutators: ReadonlyMap<string, Mutator.AnyMutator>;
  /** Mutator name → CRUD operation + type. */
  readonly operations: ReadonlyMap<string, OperationInfo>;
}

const jsonApiHeaders = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
} as const;

const trimSlashes = (s: string): string => s.replace(/\/+$/, "");

/** Resolve a route template against the base url, substituting the id param. */
const urlFor = (baseUrl: string, path: string, id?: string): string =>
  trimSlashes(baseUrl) + path.replace(/:[^/]+/g, () => encodeURIComponent(id ?? ""));

/** Stable JSON with sorted keys, so the hash is order-independent. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

/** A content-hash row version (FNV-1a over the canonical value). */
export const versionOf = (value: unknown): string => {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

const backendError = (message: string) => (cause: unknown) => new BackendError({ message, cause });

/** Build a JSON:API write body (`{ data: { type, id, attributes, ... } }`). */
const writeBody = (
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  relationships?: Record<string, unknown>
): { readonly data: Record<string, unknown> } => ({
  data: {
    type,
    id,
    attributes,
    ...(relationships !== undefined ? { relationships } : {}),
  },
});

/** Build the JsonApiBackend from its config; requires an `HttpClient`. */
export const make = (
  config: JsonApiBackendConfig
): Effect.Effect<Backend.Backend, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // collection → id → most-recently-listed value (warms getRows).
    const cache = yield* Ref.make(new Map<string, Map<string, ResourceValue>>());
    // clientGroupId → clientId → highest applied mutation id (in-session).
    const ledger = yield* Ref.make(new Map<string, Map<string, number>>());

    const getJson = (url: string) =>
      Effect.scoped(
        client.execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(jsonApiHeaders))
        )
      );

    const sendWrite = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.scoped(client.execute(request)).pipe(
        Effect.mapError(backendError("JSON:API write failed")),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : new BackendError({
                message: `JSON:API write returned HTTP ${response.status}`,
              })
        )
      );

    const cacheRows = (collection: string, rows: ReadonlyArray<ResourceValue>) =>
      Ref.update(cache, (current) => {
        const next = new Map(current);
        const map = new Map(next.get(collection) ?? []);
        for (const value of rows) map.set(value.id, value);
        next.set(collection, map);
        return next;
      });

    const evaluate: Backend.Backend["evaluate"] = (_context, subset) =>
      Effect.gen(function* () {
        const list = config.resources.get(subset.collection)?.list;
        if (list === undefined) return [];
        const response = yield* getJson(urlFor(config.baseUrl, list.path)).pipe(
          Effect.mapError(backendError(`Failed to list "${subset.collection}"`))
        );
        const document = yield* parseResponse(response).pipe(
          Effect.mapError(backendError(`Invalid JSON:API listing "${subset.collection}"`))
        );
        const values = documentToRows(document).rows.map((row) => row.value);
        yield* cacheRows(subset.collection, values);
        return Subset.apply(
          values.map((value) => ({ id: value.id, value })),
          subset
        ).map((row) => ({ id: row.id, version: versionOf(row.value) }));
      });

    const getRows: Backend.Backend["getRows"] = (_context, collection, ids) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cache)).get(collection);
        const getOne = config.resources.get(collection)?.getOne;
        const result: Array<{ id: string; version: string; value: unknown }> = [];
        for (const id of ids) {
          const hit = cached?.get(id);
          if (hit !== undefined) {
            result.push({ id, version: versionOf(hit), value: hit });
            continue;
          }
          if (getOne === undefined) continue;
          const response = yield* getJson(urlFor(config.baseUrl, getOne.path, id)).pipe(
            Effect.mapError(backendError(`Failed to fetch ${collection}/${id}`))
          );
          const document = yield* parseResponse(response).pipe(
            Effect.mapError(backendError(`Invalid JSON:API resource ${collection}/${id}`))
          );
          const value = documentToRows(document).rows[0]?.value;
          if (value !== undefined) result.push({ id, version: versionOf(value), value });
        }
        return result;
      });

    const applyOne = (
      operation: OperationInfo,
      args: unknown
    ): Effect.Effect<string, BackendError> =>
      Effect.gen(function* () {
        const resource = config.resources.get(operation.type);
        switch (operation.operation) {
          case "create": {
            const a = args as {
              id: string;
              attributes: Record<string, unknown>;
              relationships?: Record<string, unknown>;
            };
            const ref = resource?.create;
            if (ref === undefined)
              return yield* new BackendError({
                message: `No create endpoint for "${operation.type}"`,
              });
            yield* sendWrite(
              HttpClientRequest.post(urlFor(config.baseUrl, ref.path)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders),
                HttpClientRequest.bodyJsonUnsafe(
                  writeBody(operation.type, a.id, a.attributes, a.relationships)
                )
              )
            );
            return a.id;
          }
          case "update": {
            const a = args as { id: string; attributes: Record<string, unknown> };
            const ref = resource?.update;
            if (ref === undefined)
              return yield* new BackendError({
                message: `No update endpoint for "${operation.type}"`,
              });
            yield* sendWrite(
              HttpClientRequest.patch(urlFor(config.baseUrl, ref.path, a.id)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders),
                HttpClientRequest.bodyJsonUnsafe(writeBody(operation.type, a.id, a.attributes))
              )
            );
            return a.id;
          }
          case "delete": {
            const a = args as { id: string };
            const ref = resource?.delete;
            if (ref === undefined)
              return yield* new BackendError({
                message: `No delete endpoint for "${operation.type}"`,
              });
            yield* sendWrite(
              HttpClientRequest.make("DELETE")(urlFor(config.baseUrl, ref.path, a.id)).pipe(
                HttpClientRequest.setHeaders(jsonApiHeaders)
              )
            );
            return a.id;
          }
          default:
            return yield* new BackendError({
              message: `Operation "${operation.operation}" is not a write`,
            });
        }
      });

    const applyMutations: Backend.Backend["applyMutations"] = (context, mutations) =>
      Effect.gen(function* () {
        const touched = new Map<string, Set<string>>();
        for (const mutation of mutations) {
          const group = (yield* Ref.get(ledger)).get(context.clientGroupId) ?? new Map();
          const last = group.get(mutation.clientId) ?? 0;
          if (mutation.mutationId <= last) continue; // idempotent (in-session)

          const operation = config.operations.get(mutation.mutator);
          const definition = config.mutators.get(mutation.mutator);
          if (operation === undefined || definition === undefined)
            return yield* new BackendError({ message: `Unknown mutator: ${mutation.mutator}` });

          const args = yield* Schema.decodeUnknownEffect(definition.args)(mutation.args).pipe(
            Effect.mapError(backendError(`Invalid args for mutator "${mutation.mutator}"`))
          );
          const id = yield* applyOne(operation, args);

          touched.set(operation.type, (touched.get(operation.type) ?? new Set()).add(id));
          yield* Ref.update(ledger, (current) => {
            const next = new Map(current);
            const groupIds = new Map(next.get(context.clientGroupId) ?? []);
            groupIds.set(mutation.clientId, mutation.mutationId);
            next.set(context.clientGroupId, groupIds);
            return next;
          });
        }

        const finalGroup = (yield* Ref.get(ledger)).get(context.clientGroupId) ?? new Map();
        return {
          lastMutationIds: Object.fromEntries(finalGroup),
          hints: [...touched].map(([collection, ids]) => ({ collection, ids: [...ids] })),
        };
      });

    return Backend.Backend.of({
      applyMutations,
      lastMutationIds: (context) =>
        Ref.get(ledger).pipe(
          Effect.map((current) =>
            Object.fromEntries(current.get(context.clientGroupId) ?? new Map())
          )
        ),
      evaluate,
      getRows,
    });
  });
