/**
 * Example: Basic Usage
 * 
 * This example demonstrates basic usage of the effect-synchronizer library
 */

import { Effect } from "effect";
import {
  fetchResource,
  syncResourceFromRemote,
  HttpClient,
  SyncConfig,
  Storage,
  makeFetchHttpClient,
  makeInMemoryStorage,
} from "../src/index";
import type { SyncConfig as SyncConfigType } from "../src/synchronizer";

// Example 1: Simple fetch
async function example1() {
  console.log("\n=== Example 1: Fetch a resource ===");
  
  const httpClient = makeFetchHttpClient();
  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "error",
  };

  const program = fetchResource("articles", "1").pipe(
    Effect.provideService(HttpClient, httpClient),
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
  
  const httpClient = makeFetchHttpClient();
  const storage = makeInMemoryStorage();
  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "remote",
  };

  const program = syncResourceFromRemote("articles", "1", {
    include: ["author", "comments"],
  }).pipe(
    Effect.provideService(HttpClient, httpClient),
    Effect.provideService(SyncConfig, config),
    Effect.provideService(Storage, storage)
  );

  try {
    const article = await Effect.runPromise(program);
    console.log("Synced article:", article);
    
    // Verify it's in storage
    const storedArticle = await Effect.runPromise(
      storage.get("articles", "1")
    );
    console.log("Stored article:", storedArticle);
  } catch (error) {
    console.error("Failed to sync article:", error);
  }
}

// Example 3: Error handling
async function example3() {
  console.log("\n=== Example 3: Error handling ===");
  
  const httpClient = makeFetchHttpClient();
  const config: SyncConfigType = {
    baseUrl: "https://jsonapi-example.com",
    conflictStrategy: "error",
  };

  const program = fetchResource("articles", "999").pipe(
    Effect.provideService(HttpClient, httpClient),
    Effect.provideService(SyncConfig, config),
    Effect.catchTag("NetworkError", (error) => {
      console.log("Caught network error:", error.message);
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

// Run examples (uncomment to test with a real JSON:API server)
// example1();
// example2();
// example3();

export { example1, example2, example3 };
