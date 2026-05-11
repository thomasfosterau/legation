/**
 * effect-chancery
 *
 * An Effect-based library for arbitrary synchronization of data
 * following JSON:API principles
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
