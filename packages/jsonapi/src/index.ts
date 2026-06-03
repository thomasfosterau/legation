/**
 * @thomasfosterau/effect-sync-jsonapi
 *
 * A JSON:API v1.1 protocol adapter for the effect-sync engine. Exposes the
 * JSON:API types, standalone resource fetch/mutate helpers, an in-memory
 * storage implementation, and (under `Adapter`) builders that turn JSON:API
 * resources into the core engine's query and mutation descriptors.
 *
 * Formerly published as `@thomasfosterau/effect-chancery`.
 */

// Export types
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

// Export errors
export { SyncError, NetworkError, ParseError, ApiError, ConflictError } from "./errors.js";

// Export services and functions
export {
  Storage,
  SyncConfig,
  parseJsonApiResponse,
  fetchResource,
  fetchResources,
  updateResource,
  createResource,
  deleteResource,
  syncResourceFromRemote,
  syncResourcesFromRemote,
  syncResourceToRemote,
} from "./synchronizer.js";

export type { Storage as StorageInterface } from "./synchronizer.js";
export type { SyncConfig as SyncConfigInterface } from "./synchronizer.js";

// Export implementations
export { makeInMemoryStorage } from "./storage.js";

// Export the sync-engine adapter (query/mutation descriptor builders)
export * as Adapter from "./adapter.js";

// Export the JSON:API document schemas and decode helpers
export * as JsonApiSchema from "./schema.js";
