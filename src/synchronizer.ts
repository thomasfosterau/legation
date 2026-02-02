/**
 * Synchronizer Service
 * 
 * Core synchronizer implementation using Effect for managing side effects
 */

import { Effect, Context } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpClientError } from "@effect/platform";
import type {
  JsonApiDocument,
  ResourceObject,
  ResourceIdentifier,
  JsonApiRequestOptions,
} from "./types";
import {
  SyncError,
  ParseError,
  ApiError,
  ConflictError,
} from "./errors";

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
 * Type guard to check if a resource has ResourceObject properties
 */
function isResourceObject(resource: ResourceIdentifier | ResourceObject): resource is ResourceObject {
  return (
    "attributes" in resource ||
    "relationships" in resource ||
    "links" in resource
  );
}

/**
 * Build query string from JSON:API request options
 */
const buildQueryString = (options?: JsonApiRequestOptions): string => {
  if (!options) return "";

  const params = new URLSearchParams();

  if (options.include) {
    params.append("include", options.include.join(","));
  }

  if (options.fields) {
    for (const [type, fields] of Object.entries(options.fields)) {
      params.append(`fields[${type}]`, fields.join(","));
    }
  }

  if (options.sort) {
    params.append("sort", options.sort.join(","));
  }

  if (options.filter) {
    for (const [key, value] of Object.entries(options.filter)) {
      params.append(`filter[${key}]`, value);
    }
  }

  if (options.page) {
    for (const [key, value] of Object.entries(options.page)) {
      if (value !== undefined) {
        params.append(`page[${key}]`, value.toString());
      }
    }
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
};

/**
 * Parse a JSON:API response from HttpClientResponse
 */
export const parseJsonApiResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<JsonApiDocument, ParseError | ApiError | HttpClientError.HttpClientError> =>
  Effect.gen(function* (_) {
    // Check HTTP status
    if (response.status < 200 || response.status >= 300) {
      return yield* _(
        Effect.fail(
          new ApiError(
            `HTTP ${response.status}`,
            []
          )
        )
      );
    }

    const json = yield* _(
      response.json.pipe(
        Effect.mapError((error) => new ParseError("Failed to parse JSON", error))
      )
    );

    const document = json as JsonApiDocument;

    // Check for API errors
    if (document.errors && document.errors.length > 0) {
      return yield* _(
        Effect.fail(
          new ApiError("API returned errors", document.errors)
        )
      );
    }

    return document;
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
  ParseError | ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient.HttpClient);

    const url = `${config.baseUrl}/${type}/${id}${buildQueryString(options)}`;
    
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      })
    );

    const response = yield* _(client.execute(request), Effect.scoped);
    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected single resource, got collection or null")
        )
      );
    }

    const resource = document.data;
    
    // Validate it's a ResourceObject with type guard
    if (!isResourceObject(resource)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected ResourceObject with attributes, relationships, or links")
        )
      );
    }

    return resource;
  });

/**
 * Fetch multiple resources from the API
 */
export const fetchResources = (
  type: string,
  options?: JsonApiRequestOptions
): Effect.Effect<
  ResourceObject[],
  ParseError | ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient.HttpClient);

    const url = `${config.baseUrl}/${type}${buildQueryString(options)}`;
    
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      })
    );

    const response = yield* _(client.execute(request), Effect.scoped);
    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || !Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected resource collection, got single or null")
        )
      );
    }

    // Filter to ensure all items are ResourceObjects
    const resources = document.data.filter(isResourceObject);
    
    return resources;
  });

/**
 * Update a resource on the API
 */
export const updateResource = (
  resource: ResourceObject
): Effect.Effect<
  ResourceObject,
  ParseError | ApiError | ConflictError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient.HttpClient);

    const url = `${config.baseUrl}/${resource.type}/${resource.id}`;
    const body: JsonApiDocument = { data: resource };

    const request = HttpClientRequest.patch(url).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      }),
      HttpClientRequest.bodyUnsafeJson(body)
    );

    const response = yield* _(client.execute(request), Effect.scoped);

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

    const updatedResource = document.data;
    
    if (!isResourceObject(updatedResource)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected ResourceObject after update")
        )
      );
    }

    return updatedResource;
  });

/**
 * Create a resource on the API
 */
export const createResource = (
  resource: Omit<ResourceObject, "id"> & { id?: string }
): Effect.Effect<
  ResourceObject,
  ParseError | ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient.HttpClient);

    const url = `${config.baseUrl}/${resource.type}`;
    const body: JsonApiDocument = { data: resource as ResourceObject };

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      }),
      HttpClientRequest.bodyUnsafeJson(body)
    );

    const response = yield* _(client.execute(request), Effect.scoped);
    const document = yield* _(parseJsonApiResponse(response));

    if (!document.data || Array.isArray(document.data)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected single resource after creation")
        )
      );
    }

    const createdResource = document.data;
    
    if (!isResourceObject(createdResource)) {
      return yield* _(
        Effect.fail(
          new ParseError("Expected ResourceObject after creation")
        )
      );
    }

    return createdResource;
  });

/**
 * Delete a resource from the API
 */
export const deleteResource = (
  type: string,
  id: string
): Effect.Effect<
  void,
  ApiError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig
> =>
  Effect.gen(function* (_) {
    const config = yield* _(SyncConfig);
    const client = yield* _(HttpClient.HttpClient);

    const url = `${config.baseUrl}/${type}/${id}`;
    
    const request = HttpClientRequest.del(url).pipe(
      HttpClientRequest.setHeaders({
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json",
      })
    );

    const response = yield* _(client.execute(request), Effect.scoped);

    if (response.status === 204 || response.status === 200) {
      return;
    }

    return yield* _(
      Effect.fail(
        new ApiError(
          `Failed to delete resource ${type}/${id}, status: ${response.status}`,
          []
        )
      )
    );
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
  ParseError | ApiError | SyncError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig | Storage
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
  ParseError | ApiError | SyncError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig | Storage
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
  ParseError | ApiError | ConflictError | SyncError | HttpClientError.HttpClientError,
  HttpClient.HttpClient | SyncConfig | Storage
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
        const strategy = config.conflictStrategy ?? "error";
        
        if (strategy === "error") {
          return yield* _(Effect.fail(error));
        } else if (strategy === "remote") {
          // Fetch remote version and use it
          const remoteResource = yield* _(
            fetchResource(resource.type, resource.id)
          );
          yield* _(storage.set(remoteResource));
          return remoteResource;
        } else if (strategy === "local") {
          // Keep the local version, don't sync to remote
          // Just ensure it's in storage and return it
          yield* _(storage.set(resource));
          return resource;
        }
        
        return yield* _(Effect.fail(error));
      }
      
      return yield* _(Effect.fail(error));
    }
    
    const updatedResource = result.right;
    
    // Update local storage with the server's response
    yield* _(storage.set(updatedResource));
    
    return updatedResource;
  });
