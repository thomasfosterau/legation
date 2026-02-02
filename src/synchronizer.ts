/**
 * Synchronizer Service
 * 
 * Core synchronizer implementation using Effect for managing side effects
 */

import { Effect, Context } from "effect";
import type {
  JsonApiDocument,
  ResourceObject,
  JsonApiRequestOptions,
} from "./types";
import {
  SyncError,
  NetworkError,
  ParseError,
  ApiError,
  ConflictError,
} from "./errors";

/**
 * HTTP Client interface for making requests
 */
export interface HttpClient {
  readonly get: (
    url: string,
    options?: JsonApiRequestOptions
  ) => Effect.Effect<Response, NetworkError>;
  readonly post: (
    url: string,
    body: JsonApiDocument
  ) => Effect.Effect<Response, NetworkError>;
  readonly patch: (
    url: string,
    body: JsonApiDocument
  ) => Effect.Effect<Response, NetworkError>;
  readonly delete: (url: string) => Effect.Effect<Response, NetworkError>;
}

/**
 * HTTP Client service tag
 */
export const HttpClient = Context.GenericTag<HttpClient>("HttpClient");

/**
 * Storage interface for local data persistence
 */
export interface Storage {
  readonly get: (
    type: string,
    id: string
  ) => Effect.Effect<ResourceObject | null, SyncError>;
  readonly set: (
    resource: ResourceObject
  ) => Effect.Effect<void, SyncError>;
  readonly delete: (
    type: string,
    id: string
  ) => Effect.Effect<void, SyncError>;
  readonly list: (
    type: string
  ) => Effect.Effect<ResourceObject[], SyncError>;
}

/**
 * Storage service tag
 */
export const Storage = Context.GenericTag<Storage>("Storage");

/**
 * Synchronizer configuration
 */
export interface SyncConfig {
  readonly baseUrl: string;
  readonly conflictStrategy?: "local" | "remote" | "error";
  readonly autoSync?: boolean;
}

/**
 * Synchronizer service tag
 */
export const SyncConfig = Context.GenericTag<SyncConfig>("SyncConfig");

/**
 * Parse a JSON:API response
 */
export const parseJsonApiResponse = (
  response: Response
): Effect.Effect<JsonApiDocument, ParseError | ApiError> =>
  Effect.gen(function* (_) {
    try {
      const json = yield* _(
        Effect.tryPromise({
          try: () => response.json() as Promise<JsonApiDocument>,
          catch: (error) => new ParseError("Failed to parse JSON", error),
        })
      );

      // Check for API errors
      if (json.errors && json.errors.length > 0) {
        return yield* _(
          Effect.fail(
            new ApiError("API returned errors", json.errors)
          )
        );
      }

      return json;
    } catch (error) {
      return yield* _(
        Effect.fail(new ParseError("Failed to parse response", error))
      );
    }
  });

/**
 * Fetch a resource from the API
 */
export const fetchResource = (
  type: string,
  id: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  ResourceObject,
  NetworkError | ParseError | ApiError,
  HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient);

    const url = `${config.baseUrl}/${type}/${id}`;
    const response = yield* _(client.get(url, options));

    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected single resource, got collection or null")
        )
      );
    }

    return document.data as ResourceObject;
  });

/**
 * Fetch multiple resources from the API
 */
export const fetchResources = (
  type: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  ResourceObject[],
  NetworkError | ParseError | ApiError,
  HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient);

    const url = `${config.baseUrl}/${type}`;
    const response = yield* _(client.get(url, options));

    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || !Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected resource collection, got single or null")
        )
      );
    }

    return document.data as ResourceObject[];
  });

/**
 * Update a resource on the API
 */
export const updateResource = (
  resource: ResourceObject
): Effect.Effect<
  ResourceObject,
  NetworkError | ParseError | ApiError | ConflictError,
  HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient);

    const url = `${config.baseUrl}/${resource.type}/${resource.id}`;
    const body: JsonApiDocument = { data: resource };

    const response = yield* _(client.patch(url, body));

    if (response.status === 409) {
      return yield* _(
        Effect.fail(
          new ConflictError(
            "Resource version conflict",
            resource.meta?.version as string | undefined,
            undefined
          )
        )
      );
    }

    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected single resource after update")
        )
      );
    }

    return document.data as ResourceObject;
  });

/**
 * Create a resource on the API
 */
export const createResource = (
  resource: Omit<ResourceObject, "id"> & { id?: string }
): Effect.Effect<
  ResourceObject,
  NetworkError | ParseError | ApiError,
  HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient);

    const url = `${config.baseUrl}/${resource.type}`;
    const body: JsonApiDocument = { data: resource as ResourceObject };

    const response = yield* _(client.post(url, body));

    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected single resource after creation")
        )
      );
    }

    return document.data as ResourceObject;
  });

/**
 * Delete a resource from the API
 */
export const deleteResource = (
  type: string,
  id: string
): Effect.Effect<
  void,
  NetworkError | ApiError,
  HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient);

    const url = `${config.baseUrl}/${type}/${id}`;
    yield* _(client.delete(url));
  });

/**
 * Synchronize a resource from remote to local storage
 */
export const syncResourceFromRemote = (
  type: string,
  id: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  ResourceObject,
  NetworkError | ParseError | ApiError | SyncError,
  HttpClient | SyncConfig | Storage
> =>
  Effect.gen(function* (_) {
    const storage = yield* _(Storage);
    
    // Fetch from remote
    const remoteResource = yield* _(fetchResource(type, id, options));
    
    // Save to local storage
    yield* _(storage.set(remoteResource));
    
    return remoteResource;
  });

/**
 * Synchronize multiple resources from remote to local storage
 */
export const syncResourcesFromRemote = (
  type: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  ResourceObject[],
  NetworkError | ParseError | ApiError | SyncError,
  HttpClient | SyncConfig | Storage
> =>
  Effect.gen(function* (_) {
    const storage = yield* _(Storage);
    
    // Fetch from remote
    const remoteResources = yield* _(fetchResources(type, options));
    
    // Save all to local storage
    yield* _(
      Effect.all(
        remoteResources.map((resource) => storage.set(resource)),
        { concurrency: 10 }
      )
    );
    
    return remoteResources;
  });

/**
 * Synchronize a local resource to remote
 */
export const syncResourceToRemote = (
  resource: ResourceObject
): Effect.Effect<
  ResourceObject,
  NetworkError | ParseError | ApiError | ConflictError | SyncError,
  HttpClient | SyncConfig | Storage
> =>
  Effect.gen(function* (_) {
    const storage = yield* _(Storage);
    const config = yield* _(SyncConfig);
    
    // Try to update the resource on the remote
    const result = yield* _(
      Effect.either(updateResource(resource))
    );
    
    if (result._tag === "Left") {
      const error = result.left;
      
      // Handle conflict based on strategy
      if (error._tag === "ConflictError") {
        if (config.conflictStrategy === "error") {
          return yield* _(Effect.fail(error));
        } else if (config.conflictStrategy === "remote") {
          // Fetch remote version and use it
          const remoteResource = yield* _(
            fetchResource(resource.type, resource.id)
          );
          yield* _(storage.set(remoteResource));
          return remoteResource;
        }
        // If "local", continue with the update attempt (will fail again)
      }
      
      return yield* _(Effect.fail(error));
    }
    
    const updatedResource = result.right;
    
    // Update local storage with the server's response
    yield* _(storage.set(updatedResource));
    
    return updatedResource;
  });
