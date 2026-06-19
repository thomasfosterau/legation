/**
 * @thomasfosterau/effect-sync-jsonapi
 *
 * JSON:API v1.1 for the v2 sync engine (ADR-0008): map JSON:API documents
 * into collection rows — a `type` is a collection, a resource `id` is a row
 * id, a resource is a row value. The JSON:API wire types/schemas and query
 * encoding are adopted from `@thomasfosterau/effect-jsonapi` (ADR-0016); this
 * package layers the generic, resource-agnostic loaders on top.
 *
 * It also provides the convention-first **sync derivation** (`JsonApiSync`):
 * point it at an app's JSON:API `HttpApi` and it derives collections + CRUD
 * mutators and wires the whole offline/optimistic sync engine on top of the
 * existing REST API — no bespoke backend to write.
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

// Convention-first sync derivation from an app's JSON:API HttpApi.
export * as Convention from "./Convention.js";
export * as Derive from "./Derive.js";
export * as JsonApiBackend from "./JsonApiBackend.js";
export * as JsonApiQuery from "./JsonApiQuery.js";
export * as JsonApiSync from "./JsonApiSync.js";
export * as Relationships from "./Relationships.js";
