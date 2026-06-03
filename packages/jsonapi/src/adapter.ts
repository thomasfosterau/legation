/**
 * Sync-Engine Adapter
 *
 * Builders that turn JSON:API resources into the sync engine's declarative
 * query and mutation descriptors. Each helper wires the standalone fetch /
 * mutate functions in `synchronizer.ts` into `Query`, `Pagination`, and
 * `Mutation` descriptors from `@thomasfosterau/effect-sync-core`, so JSON:API
 * resources participate in caching, deduplication, invalidation, and
 * optimistic updates like any other entry.
 *
 * Keys are hierarchical: `["jsonapi", type]` for a collection, with the
 * resource `id` (and request options) appended for narrower scopes. Group
 * invalidation uses both the `["jsonapi", type]` key prefix and the
 * `jsonapi:${type}` tag.
 */

import { Effect, Option } from "effect";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { Mutation, Pagination, Query, SyncKey } from "@thomasfosterau/effect-sync-core";
import type { ApiError, ConflictError, ParseError } from "./errors.js";
import {
  createResource,
  deleteResource,
  fetchResource,
  fetchResources,
  SyncConfig,
  updateResource,
} from "./synchronizer.js";
import type { JsonApiRequestOptions, ResourceObject } from "./types.js";

/**
 * The error channel shared by every JSON:API read/write effect.
 */
export type JsonApiError = ParseError | ApiError | HttpClientError;

/**
 * The context required by every JSON:API read/write effect.
 */
export type JsonApiContext = HttpClient | SyncConfig;

/**
 * Build the sync key for a JSON:API resource or collection.
 *
 * - `["jsonapi", type]` for a collection
 * - `["jsonapi", type, id]` for a single resource
 * - request options, when given, are appended as a final object part so that
 *   differently-parameterized requests cache separately
 */
export const resourceKey = (
  type: string,
  id?: string,
  options?: JsonApiRequestOptions
): SyncKey.SyncKey => {
  const base: Array<SyncKey.SyncKeyPart> = ["jsonapi", type];
  if (id !== undefined) {
    base.push(id);
  }
  if (options !== undefined) {
    base.push(options as unknown as SyncKey.SyncKeyPart);
  }
  return base;
};

/**
 * A query descriptor that loads a single JSON:API resource by id.
 */
export const resourceQuery = (
  type: string,
  id: string,
  options?: JsonApiRequestOptions
): Query.QueryDescriptor<ResourceObject, JsonApiError, JsonApiContext> =>
  Query.make({
    key: resourceKey(type, id, options),
    loader: fetchResource(type, id, options),
    tags: [`jsonapi:${type}`],
  });

/**
 * A query descriptor that loads a collection of JSON:API resources.
 *
 * The key carries a `"list"` marker part so a collection never collides with
 * a single resource whose id happens to match request options.
 */
export const resourcesQuery = (
  type: string,
  options?: JsonApiRequestOptions
): Query.QueryDescriptor<ReadonlyArray<ResourceObject>, JsonApiError, JsonApiContext> =>
  Query.make({
    key: [...resourceKey(type, undefined, options), "list"],
    loader: fetchResources(type, options),
    tags: [`jsonapi:${type}`],
  });

/**
 * A paginated query descriptor over a JSON:API collection, using the page
 * number as the cursor.
 *
 * The next cursor is `Some(page + 1)` while there is more to load and `None`
 * once exhausted. When `options.page.size` is known, the page is considered
 * full (and therefore possibly not the last) when the returned item count
 * equals the page size; otherwise any non-empty page is assumed to have a
 * successor.
 */
export const resourcePageQuery = (
  type: string,
  options?: JsonApiRequestOptions
): Pagination.PaginatedQueryDescriptor<ResourceObject, number, JsonApiError, JsonApiContext> => {
  const size = options?.page?.size;
  return {
    key: [...resourceKey(type, undefined, options), "page"],
    tags: [`jsonapi:${type}`],
    loadPage: (cursor) => {
      const pageNumber = Option.getOrElse(cursor, () => 1);
      const page: JsonApiRequestOptions["page"] = {
        ...options?.page,
        number: pageNumber,
        ...(size !== undefined ? { size } : {}),
      };
      return Effect.map(
        fetchResources(type, { ...options, page }),
        (items): Pagination.Page<ResourceObject, number> => {
          const hasNext = size !== undefined ? items.length === size : items.length > 0;
          return {
            items,
            cursor,
            nextCursor: hasNext ? Option.some(pageNumber + 1) : Option.none(),
          };
        }
      );
    },
  };
};

/**
 * A mutation descriptor that creates a JSON:API resource.
 *
 * Invalidates the collection (`["jsonapi", type]` prefix and `jsonapi:${type}`
 * tag) so list queries refetch.
 */
export const createResourceMutation = (
  type: string
): Mutation.MutationDescriptor<
  Omit<ResourceObject, "id"> & { id?: string },
  ResourceObject,
  JsonApiError,
  JsonApiContext
> =>
  Mutation.make({
    key: ["jsonapi", type, "create"],
    execute: (input) => createResource(input),
    invalidates: [["jsonapi", type]],
    invalidatesTags: [`jsonapi:${type}`],
  });

/**
 * A mutation descriptor that updates a JSON:API resource.
 *
 * Optimistically writes the input resource under its single-resource key,
 * writes the server's canonical result on success, and invalidates the
 * collection tag.
 */
export const updateResourceMutation = (
  type: string
): Mutation.MutationDescriptor<
  ResourceObject,
  ResourceObject,
  JsonApiError | ConflictError,
  JsonApiContext
> =>
  Mutation.make({
    key: ["jsonapi", type, "update"],
    execute: (input) => updateResource(input),
    optimistic: (input) => [{ key: resourceKey(type, input.id), update: () => input }],
    updates: (_input, result) => [{ key: resourceKey(type, result.id), value: result }],
    invalidatesTags: [`jsonapi:${type}`],
  });

/**
 * A mutation descriptor that deletes a JSON:API resource by id.
 *
 * Invalidates the collection so list queries refetch.
 */
export const deleteResourceMutation = (
  type: string
): Mutation.MutationDescriptor<string, void, ApiError | HttpClientError, JsonApiContext> =>
  Mutation.make({
    key: ["jsonapi", type, "delete"],
    execute: (id) => deleteResource(type, id),
    invalidates: [["jsonapi", type]],
    invalidatesTags: [`jsonapi:${type}`],
  });
