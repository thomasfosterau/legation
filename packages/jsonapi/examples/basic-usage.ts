/**
 * Example: Basic Usage
 *
 * Demonstrates the standalone JSON:API helpers and the sync-engine adapter
 * for `@thomasfosterau/effect-sync-jsonapi`.
 */

import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { MemoryCacheStore, Mutation, Query, SyncCache } from "@thomasfosterau/effect-sync-core";
import {
  Adapter,
  fetchResource,
  syncResourceFromRemote,
  SyncConfig,
  Storage,
  makeInMemoryStorage,
} from "../src/index.js";
import type { SyncConfig as SyncConfigType } from "../src/synchronizer.js";

// Example 1: Simple fetch
async function example1() {
  console.log("\n=== Example 1: Fetch a resource ===");

  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "error",
  };

  const program = fetchResource("articles", "1").pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(SyncConfig, config)
  );

  try {
    const article = await Effect.runPromise(program);
    console.log("Fetched article:", article);
  } catch (error) {
    console.error("Failed to fetch article:", error);
  }
}

// Example 2: Sync to local storage
async function example2() {
  console.log("\n=== Example 2: Sync resource to local storage ===");

  const storage = makeInMemoryStorage();
  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "remote",
  };

  const program = syncResourceFromRemote("articles", "1", {
    include: ["author", "comments"],
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(SyncConfig, config),
    Effect.provideService(Storage, storage)
  );

  try {
    const article = await Effect.runPromise(program);
    console.log("Synced article:", article);

    // Verify it's in storage
    const storedArticle = await Effect.runPromise(storage.get("articles", "1"));
    console.log("Stored article:", storedArticle);
  } catch (error) {
    console.error("Failed to sync article:", error);
  }
}

// Example 3: Error handling
async function example3() {
  console.log("\n=== Example 3: Error handling ===");

  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "error",
  };

  const program = fetchResource("articles", "999").pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(SyncConfig, config),
    Effect.catchTag("HttpClientError", (error) => {
      console.log("Caught HTTP client error:", error);
      return Effect.succeed(null);
    }),
    Effect.catchTag("ApiError", (error) => {
      console.log("Caught API error:", error.errors);
      return Effect.succeed(null);
    })
  );

  try {
    const result = await Effect.runPromise(program);
    console.log("Result:", result);
  } catch (error) {
    console.error("Unhandled error:", error);
  }
}

// Example 4: Adapter + core SyncCache
//
// Plug JSON:API resources into the sync engine. The adapter produces query
// and mutation descriptors that the cache reads/executes, so reads are cached
// and deduplicated and writes invalidate the affected collection.
async function example4() {
  console.log("\n=== Example 4: Adapter with the sync engine ===");

  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "remote",
  };

  // SyncCache backed by an in-memory store, plus the JSON:API environment.
  const cacheLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

  const articleQuery = Adapter.resourceQuery("articles", "1");
  const createArticle = Adapter.createResourceMutation("articles");

  const program = Effect.gen(function* () {
    const cache = yield* SyncCache.SyncCache;

    // Read-through: first call hits the API, subsequent calls hit the cache.
    const article = yield* cache.read(Query.toReadOptions(articleQuery));
    console.log("Cached article:", article);

    // A create mutation invalidates the articles collection.
    const created = yield* Mutation.execute(cache, createArticle, {
      type: "articles",
      attributes: { title: "Hello" },
    });
    console.log("Created article:", created);
  }).pipe(
    Effect.provide(cacheLayer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(SyncConfig, config)
  );

  try {
    await Effect.runPromise(program);
  } catch (error) {
    console.error("Adapter example failed:", error);
  }
}

// Run examples (uncomment to test with a real JSON:API server)
// example1();
// example2();
// example3();
// example4();

export { example1, example2, example3, example4 };
