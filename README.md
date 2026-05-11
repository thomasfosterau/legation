# @thomasfosterau/effect-chancery

An Effect-based TypeScript library for synchronizing JSON:API resources between remote APIs and local storage.

## Status

This package targets Effect v4 beta and ESM-only consumers.

## Features

- JSON:API v1.1 resource, relationship, error, and request option types
- Effect-based services for configuration, storage, and HTTP execution
- Pluggable local storage with an in-memory implementation for tests and development
- Remote fetch, create, update, delete, and sync helpers
- Conflict strategies for local, remote, or fail-fast resolution
- Bun-based tooling, Vitest tests, Oxlint, Fallow analysis, Prettier formatting, and Changesets releases

## Installation

```bash
bun add @thomasfosterau/effect-chancery effect@beta
```

The library uses the HTTP client modules included in Effect v4 beta, for example `effect/unstable/http/FetchHttpClient`.

## Quick Start

```ts
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  fetchResource,
  makeInMemoryStorage,
  Storage,
  SyncConfig,
  syncResourceFromRemote,
} from "@thomasfosterau/effect-chancery";

const storage = makeInMemoryStorage();

const config = {
  baseUrl: "https://api.example.com",
  conflictStrategy: "error" as const,
};

const fetchUser = fetchResource("users", "1").pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, config)
);

const syncUser = syncResourceFromRemote("users", "1").pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(SyncConfig, config),
  Effect.provideService(Storage, storage)
);

const user = await Effect.runPromise(syncUser);
console.log(user);
```

## JSON:API Resources

```ts
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

## Synchronization

```ts
import {
  createResource,
  deleteResource,
  fetchResource,
  fetchResources,
  syncResourceFromRemote,
  syncResourcesFromRemote,
  syncResourceToRemote,
  updateResource,
} from "@thomasfosterau/effect-chancery";

const user = fetchResource("users", "1", {
  include: ["posts", "comments"],
  fields: { users: ["name", "email"] },
});

const users = fetchResources("users", {
  filter: { active: "true" },
  page: { number: 1, size: 10 },
  sort: ["name", "-created_at"],
});

const newUser = createResource({
  type: "users",
  attributes: {
    name: "Jane Doe",
    email: "jane@example.com",
  },
});

const updatedUser = updateResource({
  type: "users",
  id: "1",
  attributes: {
    name: "John Smith",
  },
});

const deleted = deleteResource("users", "1");
const pulled = syncResourceFromRemote("users", "1");
const pulledMany = syncResourcesFromRemote("users");
const pushed = syncResourceToRemote(localUser);
```

## Storage

```ts
import { Effect } from "effect";
import { SyncError, type StorageInterface } from "@thomasfosterau/effect-chancery";

const storage: StorageInterface = {
  get: (type, id) =>
    Effect.tryPromise({
      try: () => database.findOne({ type, id }),
      catch: (error) => new SyncError("Failed to get resource", error),
    }),
  set: (resource) =>
    Effect.tryPromise({
      try: () => database.save(resource),
      catch: (error) => new SyncError("Failed to save resource", error),
    }),
  delete: (type, id) =>
    Effect.tryPromise({
      try: () => database.delete({ type, id }),
      catch: (error) => new SyncError("Failed to delete resource", error),
    }),
  list: (type) =>
    Effect.tryPromise({
      try: () => database.findAll({ type }),
      catch: (error) => new SyncError("Failed to list resources", error),
    }),
};
```

## Conflict Strategy

```ts
const config = {
  baseUrl: "https://api.example.com",
  conflictStrategy: "remote" as const,
};
```

- `local`: keep the local resource when the remote update reports a conflict
- `remote`: fetch and store the remote resource when a conflict occurs
- `error`: fail with `ConflictError`

## Development

```bash
bun ci
bun run typecheck
bun run build
bun run test:run
bun run lint
bun run format:check
bun run analyze:audit
```

Changesets manages versions and changelogs:

```bash
bun run changeset
```
