/**
 * @thomasfosterau/effect-sync-jsonapi
 *
 * JSON:API v1.1 as a *collection loader* for the v2 sync engine (ADR-0008):
 * map JSON:API documents into collection rows — a `type` is a collection,
 * a resource `id` is a row id, a resource is a row value. The package owns
 * the JSON:API types, schemas, and read-side loaders; it does not own a
 * sync model (writes in the engine are named mutators).
 *
 * Formerly published as `@thomasfosterau/effect-chancery`.
 */

// JSON:API types and document schemas
export type {
  ResourceIdentifier,
  ResourceObject,
  Relationship,
  Links,
  LinkObject,
  JsonApiError,
  JsonApiDocument,
  JsonApiRequestOptions,
} from "./types.js";

export * as JsonApiSchema from "./schema.js";

// Errors
export { SyncError, NetworkError, ParseError, ApiError, ConflictError } from "./errors.js";

// Collection loaders: documents → engine rows, and read-side fetching.
export * as CollectionLoader from "./CollectionLoader.js";
