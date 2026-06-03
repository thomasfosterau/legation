import { describe, it, expect } from "vitest";
import { Effect, Layer, Result } from "effect";
import { ApiError, ConflictError, ParseError } from "../errors.js";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  fetchResource,
  SyncConfig,
  syncResourceFromRemote,
  syncResourceToRemote,
  Storage,
} from "../synchronizer.js";
import { makeInMemoryStorage } from "../storage.js";
import type { ResourceObject, JsonApiDocument } from "../types.js";

describe("Synchronizer", () => {
  const mockConfig = {
    baseUrl: "https://api.example.com",
    conflictStrategy: "error" as const,
  };

  // Create a mock HTTP client layer for testing
  const mockHttpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const url = request.url;

      if (url.includes("/users/1") && !url.includes("/users/10")) {
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

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(document), {
              status: 200,
              headers: { "Content-Type": "application/vnd.api+json" },
            })
          )
        );
      }

      if (url.includes("/users/404")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), {
              status: 404,
              headers: { "Content-Type": "application/vnd.api+json" },
            })
          )
        );
      }

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))
      );
    })
  );

  it("should fetch a resource from the API", async () => {
    const program = fetchResource("users", "1").pipe(
      Effect.provide(mockHttpClientLayer),
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
      Effect.provide(mockHttpClientLayer),
      Effect.provideService(SyncConfig, mockConfig),
      Effect.provideService(Storage, storage)
    );

    const result = await Effect.runPromise(program);

    expect(result.type).toBe("users");
    expect(result.id).toBe("1");

    // Verify it was saved to storage
    const storedResource = await Effect.runPromise(storage.get("users", "1"));
    expect(storedResource).not.toBeNull();
    expect(storedResource?.attributes?.name).toBe("John Doe");
  });

  it("should handle HTTP error responses", async () => {
    const program = fetchResource("users", "404").pipe(
      Effect.provide(mockHttpClientLayer),
      Effect.provideService(SyncConfig, mockConfig)
    );

    await expect(Effect.runPromise(program)).rejects.toThrow("HTTP 404");
  });

  it("fails with a tagged ApiError carrying message and errors", async () => {
    const program = fetchResource("users", "404").pipe(
      Effect.provide(mockHttpClientLayer),
      Effect.provideService(SyncConfig, mockConfig),
      Effect.result,
      Effect.map((result) => (Result.isFailure(result) ? result.failure : undefined))
    );

    const error = await Effect.runPromise(program);

    expect(error).toBeInstanceOf(ApiError);
    expect(error?._tag).toBe("ApiError");
    expect(error?.message).toBe("HTTP 404");
  });

  it("constructs tagged errors with the object constructor style", () => {
    const parse = new ParseError({ message: "bad", cause: new Error("x") });
    expect(parse._tag).toBe("ParseError");
    expect(parse.message).toBe("bad");

    const conflict = new ConflictError({
      message: "conflict",
      localVersion: "1",
      remoteVersion: "2",
    });
    expect(conflict._tag).toBe("ConflictError");
    expect(conflict.localVersion).toBe("1");
    expect(conflict.remoteVersion).toBe("2");
  });

  it("should handle conflicts with local strategy", async () => {
    const storage = makeInMemoryStorage();
    const conflictConfig = {
      baseUrl: "https://api.example.com",
      conflictStrategy: "local" as const,
    };

    const conflictHttpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            HttpClientRequest.get("http://test"),
            new Response(null, { status: 409 })
          )
        )
      )
    );

    const localResource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "Local User",
        version: "1",
      },
    };

    const program = syncResourceToRemote(localResource).pipe(
      Effect.provide(conflictHttpClientLayer),
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
    const conflictConfig = {
      baseUrl: "https://api.example.com",
      conflictStrategy: "remote" as const,
    };

    const conflictHttpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
        const method = request.method;

        if (method === "PATCH") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 409 }))
          );
        }

        // GET request for fetching remote version
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

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(document), {
              status: 200,
              headers: { "Content-Type": "application/vnd.api+json" },
            })
          )
        );
      })
    );

    const localResource: ResourceObject = {
      type: "users",
      id: "1",
      attributes: {
        name: "Local User",
        version: "1",
      },
    };

    const program = syncResourceToRemote(localResource).pipe(
      Effect.provide(conflictHttpClientLayer),
      Effect.provideService(SyncConfig, conflictConfig),
      Effect.provideService(Storage, storage)
    );

    const result = await Effect.runPromise(program);

    // Should use the remote version
    expect(result.attributes?.name).toBe("Remote User");
    expect(result.attributes?.version).toBe("2");
  });
});
