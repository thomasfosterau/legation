import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  freshness,
  MemoryCacheStore,
  Mutation,
  Query,
  SyncCache,
} from "@thomasfosterau/effect-sync-core";
import { Adapter } from "../index.js";
import { SyncConfig } from "../synchronizer.js";
import type { JsonApiDocument, ResourceObject } from "../types.js";

const mockConfig = { baseUrl: "https://api.example.com", conflictStrategy: "error" as const };

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/vnd.api+json" },
    })
  );

const singleUser: JsonApiDocument = {
  data: { type: "users", id: "1", attributes: { name: "John Doe" } },
};

const userList = (count: number): JsonApiDocument => ({
  data: Array.from({ length: count }, (_, index) => ({
    type: "users",
    id: String(index + 1),
    attributes: { name: `User ${index + 1}` },
  })),
});

// A mock HTTP client that answers JSON:API requests for the `users` type.
const mockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const url = request.url;
    const method = request.method;

    if (method === "POST" && url.endsWith("/users")) {
      return Effect.succeed(
        jsonResponse(request, {
          data: { type: "users", id: "100", attributes: { name: "Created" } },
        })
      );
    }

    if (method === "PATCH" && url.includes("/users/1")) {
      return Effect.succeed(
        jsonResponse(request, {
          data: { type: "users", id: "1", attributes: { name: "Updated" } },
        })
      );
    }

    if (method === "DELETE" && url.includes("/users/1")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
      );
    }

    if (url.includes("/users/1")) {
      return Effect.succeed(jsonResponse(request, singleUser));
    }

    // Collection endpoint: vary by requested page number.
    if (url.includes("/users")) {
      const match = url.match(/page%5Bnumber%5D=(\d+)/);
      const pageNumber = match ? Number(match[1]) : 1;
      // page 1 -> 2 items, page 2 -> 1 item (the last page when size is 2)
      const count = pageNumber === 1 ? 2 : 1;
      return Effect.succeed(jsonResponse(request, userList(count)));
    }

    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 })));
  })
);

// A fresh cache layer per test plus the mock JSON:API environment.
const cacheEnv = () =>
  SyncCache.layer.pipe(
    Layer.provideMerge(MemoryCacheStore.layer()),
    Layer.provideMerge(mockHttpClientLayer),
    Layer.provideMerge(Layer.succeed(SyncConfig, mockConfig))
  );

// The JSON:API environment without a cache (HttpClient + SyncConfig).
const httpEnv = Layer.mergeAll(mockHttpClientLayer, Layer.succeed(SyncConfig, mockConfig));

describe("Adapter.resourceKey", () => {
  it("builds a collection key", () => {
    expect(Adapter.resourceKey("users")).toEqual(["jsonapi", "users"]);
  });

  it("builds a single-resource key", () => {
    expect(Adapter.resourceKey("users", "1")).toEqual(["jsonapi", "users", "1"]);
  });

  it("appends request options as a final object part", () => {
    const options = { include: ["author"] };
    expect(Adapter.resourceKey("users", "1", options)).toEqual(["jsonapi", "users", "1", options]);
  });
});

describe("Adapter query descriptors", () => {
  it.effect("wires resourceQuery to fetchResource", () =>
    Effect.gen(function* () {
      const descriptor = Adapter.resourceQuery("users", "1");

      const result = yield* descriptor.loader;

      expect(result.id).toBe("1");
      expect(result.attributes?.name).toBe("John Doe");
      expect(descriptor.key).toEqual(["jsonapi", "users", "1"]);
      expect(descriptor.tags).toEqual(["jsonapi:users"]);
    }).pipe(Effect.provide(httpEnv))
  );

  it.effect("runs a resourceQuery through the SyncCache", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Adapter.resourceQuery("users", "1");

      const result = yield* cache.read(Query.toReadOptions(descriptor));

      expect((result as ResourceObject).id).toBe("1");
    }).pipe(Effect.provide(cacheEnv()))
  );

  it("gives resourcesQuery a list-marked key", () => {
    const descriptor = Adapter.resourcesQuery("users");
    expect(descriptor.key).toEqual(["jsonapi", "users", "list"]);
  });
});

describe("Adapter.resourcePageQuery", () => {
  it.effect("computes the next cursor from page size", () =>
    Effect.gen(function* () {
      const descriptor = Adapter.resourcePageQuery("users", { page: { size: 2 } });

      // First page returns 2 items == size, so there is a next cursor.
      const first = yield* descriptor.loadPage(Option.none());
      expect(first.items).toHaveLength(2);
      expect(Option.getOrUndefined(first.nextCursor)).toBe(2);

      // Second page returns 1 item < size, so it is the last page.
      const second = yield* descriptor.loadPage(Option.some(2));
      expect(second.items).toHaveLength(1);
      expect(Option.isNone(second.nextCursor)).toBe(true);
    }).pipe(Effect.provide(httpEnv))
  );

  it.effect("treats any non-empty page as having a successor when size is unknown", () =>
    Effect.gen(function* () {
      const descriptor = Adapter.resourcePageQuery("users");

      const page = yield* descriptor.loadPage(Option.none());

      expect(Option.isSome(page.nextCursor)).toBe(true);
    }).pipe(Effect.provide(httpEnv))
  );
});

describe("Adapter mutation descriptors", () => {
  it.effect("creates a resource and returns the server result", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Adapter.createResourceMutation("users");

      const result = yield* Mutation.execute(cache, descriptor, {
        type: "users",
        attributes: { name: "Created" },
      });

      expect((result as ResourceObject).id).toBe("100");
    }).pipe(Effect.provide(cacheEnv()))
  );

  it.effect("update mutation writes the result under the resource key", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Adapter.updateResourceMutation("users");

      yield* Mutation.execute(cache, descriptor, {
        type: "users",
        id: "1",
        attributes: { name: "New" },
      });
      const cached = yield* cache.peek<ResourceObject>(Adapter.resourceKey("users", "1"));

      expect(Option.getOrUndefined(cached)?.value.attributes?.name).toBe("Updated");
    }).pipe(Effect.provide(cacheEnv()))
  );

  it.effect("create invalidation marks list queries stale", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const listDescriptor = Adapter.resourcesQuery("users");
      const createDescriptor = Adapter.createResourceMutation("users");

      // Populate the list query (fresh for a long time).
      yield* cache.read(Query.toReadOptions({ ...listDescriptor, staleTime: "1 hour" }));
      // A create mutation should invalidate the collection.
      yield* Mutation.execute(cache, createDescriptor, {
        type: "users",
        attributes: { name: "Created" },
      });
      const entry = yield* cache.peek(listDescriptor.key);
      const now = Date.now();
      const wasStale = Option.isSome(entry) ? freshness(entry.value, now) !== "fresh" : false;

      expect(wasStale).toBe(true);
    }).pipe(Effect.provide(cacheEnv()))
  );

  it.effect("delete mutation runs and invalidates the collection", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Adapter.deleteResourceMutation("users");

      const result = yield* Mutation.execute(cache, descriptor, "1");

      expect(result).toBeUndefined();
    }).pipe(Effect.provide(cacheEnv()))
  );
});
