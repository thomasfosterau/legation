/**
 * effect-synchronizer
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
} from "./types";

// Export errors
export {
  SyncError,
  NetworkError,
  ParseError,
  ApiError,
  ConflictError,
} from "./errors";

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
} from "./synchronizer";

export type { Storage as StorageInterface } from "./synchronizer";
export type { SyncConfig as SyncConfigInterface } from "./synchronizer";

// Export implementations
export { makeInMemoryStorage } from "./storage";
