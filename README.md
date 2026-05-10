# @thomasfosterau/effect-chancery

An Effect-based library for arbitrary synchronization of data following JSON:API principles.

## Overview

`@thomasfosterau/effect-chancery` is a TypeScript library that provides a robust, type-safe synchronization engine for managing data between local storage and remote APIs that follow the [JSON:API specification](https://jsonapi.org/). Built on top of the [Effect](https://effect.website/) library, it leverages functional programming principles to provide composable, testable, and maintainable synchronization logic.

## Features

- **JSON:API Compliant**: Follows the JSON:API v1.1 specification for consistent API interactions
- **Effect-Based**: Built on Effect for robust error handling, dependency injection, and composability
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Flexible Storage**: Pluggable storage interface for custom persistence implementations
- **Conflict Resolution**: Built-in strategies for handling synchronization conflicts
- **Resource Relationships**: Support for JSON:API relationships and included resources
- **Query Options**: Support for sparse fieldsets, filtering, sorting, and pagination

## Installation

```bash
npm install @thomasfosterau/effect-chancery effect @effect/platform
```

## Quick Start

```typescript
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";
import {
  fetchResource,
  syncResourceFromRemote,
  SyncConfig,
  Storage,
  makeInMemoryStorage,
} from "@thomasfosterau/effect-chancery";

// Create service implementations
const storage = makeInMemoryStorage();
const config = {
  baseUrl: "https://api.example.com",
  conflictStrategy: "error" as const,
};

// Fetch a resource from the API
const fetchUser = fetchResource("users", "1").pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, config)
);

// Sync a resource from remote to local storage
const syncUser = syncResourceFromRemote("users", "1").pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, config),
  Effect.provideService(Storage, storage)
);

// Run the effect
Effect.runPromise(syncUser)
  .then((user) => console.log("Synced user:", user))
  .catch((error) => console.error("Sync failed:", error));
```

## Core Concepts

### JSON:API Resources

Resources follow the JSON:API specification:

```typescript
import type { ResourceObject } from "@thomasfosterau/effect-chancery";

const user: ResourceObject = {
  type: "users",
  id: "1",
  attributes: {
    name: "John Doe",
    email: "john@example.com",
  },
  relationships: {
    posts: {
      data: [
        { type: "posts", id: "1" },
        { type: "posts", id: "2" },
      ],
    },
  },
};
```

### Services

The library uses two main services:

- **HttpClient**: Provided by @effect/platform for HTTP requests to the JSON:API server
- **Storage**: Manages local persistence of resources (custom implementation required or use provided in-memory storage)
- **SyncConfig**: Configuration for synchronization behavior

The library leverages @effect/platform's `HttpClient` service, which provides platform-agnostic HTTP client capabilities with built-in resource management and error handling.

### Synchronization Operations

```typescript
import {
  fetchResource,
  fetchResources,
  updateResource,
  createResource,
  deleteResource,
  syncResourceFromRemote,
  syncResourcesFromRemote,
  syncResourceToRemote,
} from "@thomasfosterau/effect-chancery";

// Fetch a single resource
const user = fetchResource("users", "1", {
  include: ["posts", "comments"],
  fields: { users: ["name", "email"] },
});

// Fetch multiple resources with filtering and pagination
const users = fetchResources("users", {
  filter: { active: "true" },
  page: { number: 1, size: 10 },
  sort: ["name", "-created_at"],
});

// Create a new resource
const newUser = createResource({
  type: "users",
  attributes: {
    name: "Jane Doe",
    email: "jane@example.com",
  },
});

// Update an existing resource
const updatedUser = updateResource({
  type: "users",
  id: "1",
  attributes: {
    name: "John Smith",
  },
});

// Sync from remote to local
const synced = syncResourceFromRemote("users", "1");

// Sync local changes to remote
const pushed = syncResourceToRemote(localUser);
```

### Error Handling

The library provides specific error types for different failure scenarios:

```typescript
import { Effect } from "effect";
import {
  fetchResource,
  NetworkError,
  ParseError,
  ApiError,
  ConflictError,
} from "@thomasfosterau/effect-chancery";

const program = fetchResource("users", "1").pipe(
  Effect.catchTag("NetworkError", (error) => {
    console.error("Network error:", error.message);
    return Effect.succeed(null);
  }),
  Effect.catchTag("ApiError", (error) => {
    console.error("API errors:", error.errors);
    return Effect.succeed(null);
  })
);
```

### Conflict Resolution

Configure how conflicts are handled during synchronization:

```typescript
const config = {
  baseUrl: "https://api.example.com",
  conflictStrategy: "remote" as const, // Options: "local", "remote", "error"
};
```

- **local**: Keep the local version when conflicts occur
- **remote**: Use the remote version when conflicts occur
- **error**: Fail and return a ConflictError when conflicts occur

## Custom Implementations

### Custom Storage

Implement your own storage backend:

```typescript
import { Effect } from "effect";
import type { Storage } from "@thomasfosterau/effect-chancery";

const myCustomStorage: Storage = {
  get: (type, id) =>
    Effect.tryPromise({
      try: () => myDatabase.findOne({ type, id }),
      catch: (error) => new SyncError("Failed to get resource", error),
    }),
  set: (resource) =>
    Effect.tryPromise({
      try: () => myDatabase.save(resource),
      catch: (error) => new SyncError("Failed to save resource", error),
    }),
  delete: (type, id) =>
    Effect.tryPromise({
      try: () => myDatabase.delete({ type, id }),
      catch: (error) => new SyncError("Failed to delete resource", error),
    }),
  list: (type) =>
    Effect.tryPromise({
      try: () => myDatabase.findAll({ type }),
      catch: (error) => new SyncError("Failed to list resources", error),
    }),
};
```

### Custom HTTP Client

You can customize the HTTP client using @effect/platform's layers and middleware:

```typescript
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { FetchHttpClient } from "@effect/platform";

// Create a custom HTTP client layer with authentication
const myCustomHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* (_) {
    const defaultClient = yield* _(FetchHttpClient.layer);
    
    return defaultClient.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://api.example.com"),
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${myAuthToken}`,
          "Content-Type": "application/vnd.api+json",
        })
      )
    );
  })
);

// Use with the synchronizer
const program = fetchResource("users", "1").pipe(
  Effect.provide(myCustomHttpClientLayer),
  Effect.provideService(SyncConfig, config)
);
```

## API Reference

### Types

- `ResourceObject`: JSON:API resource with type, id, attributes, and relationships
- `JsonApiDocument`: Complete JSON:API document structure
- `JsonApiError`: JSON:API error object
- `JsonApiRequestOptions`: Query parameters for API requests

### Services

- `HttpClient`: Provided by @effect/platform - HTTP client service for making API requests
- `Storage`: Storage service for local persistence (custom implementation or use `makeInMemoryStorage`)
- `SyncConfig`: Configuration service for synchronization behavior

### Functions

- `fetchResource(type, id, options?)`: Fetch a single resource from the API
- `fetchResources(type, options?)`: Fetch multiple resources from the API
- `updateResource(resource)`: Update a resource on the API
- `createResource(resource)`: Create a new resource on the API
- `deleteResource(type, id)`: Delete a resource from the API
- `syncResourceFromRemote(type, id, options?)`: Sync a resource from remote to local
- `syncResourcesFromRemote(type, options?)`: Sync multiple resources from remote to local
- `syncResourceToRemote(resource)`: Sync a local resource to remote

### Implementations

- `makeInMemoryStorage()`: Create an in-memory storage implementation for testing/development

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Thomas Foster

