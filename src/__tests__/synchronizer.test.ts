import { describe, it, expect } from "vitest";
import { Effect, Context } from "effect";
import {
  fetchResource,
  HttpClient,
  SyncConfig,
  syncResourceFromRemote,
  syncResourceToRemote,
  Storage,
} from "../synchronizer";
import { makeInMemoryStorage } from "../storage";
import type { ResourceObject, JsonApiDocument } from "../types";
import { NetworkError, ConflictError } from "../errors";

describe("Synchronizer", () => {
  const mockHttpClient: HttpClient = {
    get: (url: string) => {
      if (url.includes("/users/1")) {
        const document: JsonApiDocument = {
          data: {
            type: "users",
            id: "1",
            attributes: {
              name: "John Doe",
              email: "john@example.com",
            },
          },
        };
        return Effect.succeed({
          status: 200,
          json: () => Promise.resolve(document),
        } as Response);
      }
      return Effect.fail(new NetworkError("Not found"));
    },
    post: () => Effect.fail(new NetworkError("Not implemented")),
    patch: () => Effect.fail(new NetworkError("Not implemented")),
    delete: () => Effect.fail(new NetworkError("Not implemented")),
  };

  const mockConfig: SyncConfig = {
    baseUrl: "https://api.example.com",
    conflictStrategy: "error",
  };

  it("should fetch a resource from the API", async () => {
    const program = fetchResource("users", "1").pipe(
      Effect.provideService(HttpClient, mockHttpClient),
      Effect.provideService(SyncConfig, mockConfig)
    );

    const result = await Effect.runPromise(program);

    expect(result.type).toBe("users");
    expect(result.id).toBe("1");
    expect(result.attributes?.name).toBe("John Doe");
  });

  it("should sync a resource from remote to storage", async () => {
    const storage = makeInMemoryStorage();

    const program = syncResourceFromRemote("users", "1").pipe(
      Effect.provideService(HttpClient, mockHttpClient),
      Effect.provideService(SyncConfig, mockConfig),
      Effect.provideService(Storage, storage)
    );

    const result = await Effect.runPromise(program);

    expect(result.type).toBe("users");
    expect(result.id).toBe("1");

    // Verify it was saved to storage
    const storedResource = await Effect.runPromise(
      storage.get("users", "1")
    );
    expect(storedResource).not.toBeNull();
    expect(storedResource?.attributes?.name).toBe("John Doe");
  });

  it("should handle network errors gracefully", async () => {
    const program = fetchResource("users", "999").pipe(
      Effect.provideService(HttpClient, mockHttpClient),
      Effect.provideService(SyncConfig, mockConfig)
    );

    await expect(Effect.runPromise(program)).rejects.toThrow();
  });

  it("should handle conflicts with local strategy", async () => {
    const storage = makeInMemoryStorage();
    const conflictConfig: SyncConfig = {
      baseUrl: "https://api.example.com",
      conflictStrategy: "local",
    };

    const conflictHttpClient: HttpClient = {
      get: (url: string) => Effect.fail(new NetworkError("Not implemented")),
      post: () => Effect.fail(new NetworkError("Not implemented")),
      patch: () =>
        Effect.succeed({
          status: 409,
          json: () => Promise.resolve({}),
        } as Response),
      delete: () => Effect.fail(new NetworkError("Not implemented")),
    };

    const localResource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "Local User",
        version: "1",
      },
    };

    const program = syncResourceToRemote(localResource).pipe(
      Effect.provideService(HttpClient, conflictHttpClient),
      Effect.provideService(SyncConfig, conflictConfig),
      Effect.provideService(Storage, storage)
    );

    const result = await Effect.runPromise(program);

    // Should keep the local version
    expect(result.attributes?.name).toBe("Local User");
    expect(result.attributes?.version).toBe("1");
  });

  it("should handle conflicts with remote strategy", async () => {
    const storage = makeInMemoryStorage();
    const conflictConfig: SyncConfig = {
      baseUrl: "https://api.example.com",
      conflictStrategy: "remote",
    };

    const conflictHttpClient: HttpClient = {
      get: (url: string) => {
        const document: JsonApiDocument = {
          data: {
            type: "users",
            id: "1",
            attributes: {
              name: "Remote User",
              version: "2",
            },
          },
        };
        return Effect.succeed({
          status: 200,
          json: () => Promise.resolve(document),
        } as Response);
      },
      post: () => Effect.fail(new NetworkError("Not implemented")),
      patch: () =>
        Effect.succeed({
          status: 409,
          json: () => Promise.resolve({}),
        } as Response),
      delete: () => Effect.fail(new NetworkError("Not implemented")),
    };

    const localResource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "Local User",
        version: "1",
      },
    };

    const program = syncResourceToRemote(localResource).pipe(
      Effect.provideService(HttpClient, conflictHttpClient),
      Effect.provideService(SyncConfig, conflictConfig),
      Effect.provideService(Storage, storage)
    );

    const result = await Effect.runPromise(program);

    // Should use the remote version
    expect(result.attributes?.name).toBe("Remote User");
    expect(result.attributes?.version).toBe("2");
  });
});
