/**
 * Synchronizer Service
 *
 * Core synchronizer implementation using Effect for managing side effects
 */

import { Effect, Context, Result } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type {
  JsonApiDocument,
  ResourceObject,
  ResourceIdentifier,
  JsonApiRequestOptions,
} from "./types.js";
import { SyncError, ParseError, ApiError, ConflictError } from "./errors.js";
import { decodeDocument } from "./schema.js";

/**
 * Storage interface for local data persistence
 */
export interface Storage {
  readonly get: (type: string, id: string) => Effect.Effect<ResourceObject | null, SyncError>;
  readonly set: (resource: ResourceObject) => Effect.Effect<void, SyncError>;
  readonly delete: (type: string, id: string) => Effect.Effect<void, SyncError>;
  readonly list: (type: string) => Effect.Effect<ResourceObject[], SyncError>;
}

/**
 * Storage service tag
 */
export const Storage = Context.Service<Storage>("Storage");

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
export const SyncConfig = Context.Service<SyncConfig>("SyncConfig");

/**
 * Type guard to check if a resource has ResourceObject properties
 */
function isResourceObject(
  resource: ResourceIdentifier | ResourceObject
): resource is ResourceObject {
  return "attributes" in resource || "relationships" in resource || "links" in resource;
}

/**
 * Append a `prefix[key]=value` family of parameters.
 */
const appendBracketedParams = (
  params: URLSearchParams,
  prefix: string,
  record: Record<string, string | number | undefined>
): void => {
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      params.append(`${prefix}[${key}]`, value.toString());
    }
  }
};

/**
 * Build query string from JSON:API request options
 */
const buildQueryString = (options?: JsonApiRequestOptions): string => {
  if (!options) return "";

  const params = new URLSearchParams();

  if (options.include) {
    params.append("include", options.include.join(","));
  }

  if (options.sort) {
    params.append("sort", options.sort.join(","));
  }

  if (options.fields) {
    const joined = Object.fromEntries(
      Object.entries(options.fields).map(([type, fields]) => [type, fields.join(",")])
    );
    appendBracketedParams(params, "fields", joined);
  }

  if (options.filter) {
    appendBracketedParams(params, "filter", options.filter);
  }

  if (options.page) {
    appendBracketedParams(params, "page", options.page);
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
};

/**
 * Headers required on every JSON:API request.
 */
const jsonApiHeaders = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
} as const;

/**
 * Build a JSON:API GET request.
 */
const jsonApiGet = (url: string): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(jsonApiHeaders));

/**
 * Extract a single `ResourceObject` from a document, failing with
 * `ParseError` when the document holds a collection, null, or a bare
 * resource identifier.
 */
const requireSingleResource = (
  document: JsonApiDocument,
  context: string
): Effect.Effect<ResourceObject, ParseError> => {
  if (!document.data || Array.isArray(document.data)) {
    return Effect.fail(
      new ParseError({ message: `Expected single resource ${context}, got collection or null` })
    );
  }
  if (!isResourceObject(document.data)) {
    return Effect.fail(new ParseError({ message: `Expected ResourceObject ${context}` }));
  }
  return Effect.succeed(document.data);
};

/**
 * Parse a JSON:API response from HttpClientResponse
 */
export const parseJsonApiResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<JsonApiDocument, ParseError | ApiError | HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    // Check HTTP status
    if (response.status < 200 || response.status >= 300) {
      return yield* new ApiError({ message: `HTTP ${response.status}`, errors: [] });
    }

    const json = yield* response.json.pipe(
      Effect.mapError((error) => new ParseError({ message: "Failed to parse JSON", cause: error }))
    );

    const document = yield* decodeDocument(json);

    // Check for API errors
    if (document.errors && document.errors.length > 0) {
      return yield* new ApiError({ message: "API returned errors", errors: document.errors });
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
  Effect.gen(function* () {
    const config = yield* SyncConfig;
    const client = yield* HttpClient.HttpClient;

    const url = `${config.baseUrl}/${type}/${id}${buildQueryString(options)}`;

    const response = yield* Effect.scoped(client.execute(jsonApiGet(url)));
    const document = yield* parseJsonApiResponse(response);

    return yield* requireSingleResource(document, "from fetch");
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
  Effect.gen(function* () {
    const config = yield* SyncConfig;
    const client = yield* HttpClient.HttpClient;

    const url = `${config.baseUrl}/${type}${buildQueryString(options)}`;

    const response = yield* Effect.scoped(client.execute(jsonApiGet(url)));
    const document = yield* parseJsonApiResponse(response);

    if (!document.data || !Array.isArray(document.data)) {
      return yield* new ParseError({ message: "Expected resource collection, got single or null" });
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
  Effect.gen(function* () {
    const config = yield* SyncConfig;
    const client = yield* HttpClient.HttpClient;

    const url = `${config.baseUrl}/${resource.type}/${resource.id}`;
    const body: JsonApiDocument = { data: resource };

    const request = HttpClientRequest.patch(url).pipe(
      HttpClientRequest.setHeaders(jsonApiHeaders),
      HttpClientRequest.bodyJsonUnsafe(body)
    );

    const response = yield* Effect.scoped(client.execute(request));

    if (response.status === 409) {
      return yield* new ConflictError({
        message: "Resource version conflict",
        localVersion: resource.meta?.version as string | undefined,
        remoteVersion: undefined,
      });
    }

    const document = yield* parseJsonApiResponse(response);

    return yield* requireSingleResource(document, "after update");
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
  Effect.gen(function* () {
    const config = yield* SyncConfig;
    const client = yield* HttpClient.HttpClient;

    const url = `${config.baseUrl}/${resource.type}`;
    const body: JsonApiDocument = { data: resource as ResourceObject };

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(jsonApiHeaders),
      HttpClientRequest.bodyJsonUnsafe(body)
    );

    const response = yield* Effect.scoped(client.execute(request));
    const document = yield* parseJsonApiResponse(response);

    return yield* requireSingleResource(document, "after creation");
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
  Effect.gen(function* () {
    const config = yield* SyncConfig;
    const client = yield* HttpClient.HttpClient;

    const url = `${config.baseUrl}/${type}/${id}`;

    const request = HttpClientRequest.delete(url).pipe(
      HttpClientRequest.setHeaders(jsonApiHeaders)
    );

    const response = yield* Effect.scoped(client.execute(request));

    if (response.status === 204 || response.status === 200) {
      return;
    }

    return yield* new ApiError({
      message: `Failed to delete resource ${type}/${id}, status: ${response.status}`,
      errors: [],
    });
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
  Effect.gen(function* () {
    const storage = yield* Storage;

    // Fetch from remote
    const remoteResource = yield* fetchResource(type, id, options);

    // Save to local storage
    yield* storage.set(remoteResource);

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
  Effect.gen(function* () {
    const storage = yield* Storage;

    // Fetch from remote
    const remoteResources = yield* fetchResources(type, options);

    // Save all to local storage
    yield* Effect.all(
      remoteResources.map((resource) => storage.set(resource)),
      { concurrency: 10 }
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
  Effect.gen(function* () {
    const storage = yield* Storage;
    const config = yield* SyncConfig;

    // Try to update the resource on the remote
    const result = yield* Effect.result(updateResource(resource));

    if (Result.isFailure(result)) {
      const error = result.failure;

      // Handle conflict based on strategy
      if (error instanceof ConflictError) {
        const strategy = config.conflictStrategy ?? "error";

        if (strategy === "error") {
          return yield* error;
        } else if (strategy === "remote") {
          // Fetch remote version and use it
          const remoteResource = yield* fetchResource(resource.type, resource.id);
          yield* storage.set(remoteResource);
          return remoteResource;
        } else if (strategy === "local") {
          // Keep the local version, don't sync to remote
          // Just ensure it's in storage and return it
          yield* storage.set(resource);
          return resource;
        }

        return yield* error;
      }

      return yield* error;
    }

    const updatedResource = result.success;

    // Update local storage with the server's response
    yield* storage.set(updatedResource);

    return updatedResource;
  });
