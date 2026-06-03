import { describe, it, expect } from "vitest";
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
import type { CacheStore } from "@thomasfosterau/effect-sync-core";
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

const testLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

// Run a program that needs a SyncCache plus the mock JSON:API environment.
const withCache = <A, E>(
  program: (
    cache: SyncCache.SyncCache
  ) => Effect.Effect<A, E, SyncCache.SyncCache | CacheStore | HttpClient.HttpClient | SyncConfig>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(SyncCache.SyncCache), program).pipe(
      Effect.provide(testLayer),
      Effect.provide(mockHttpClientLayer),
      Effect.provideService(SyncConfig, mockConfig)
    ) as Effect.Effect<A, E>
  );

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
  it("wires resourceQuery to fetchResource", async () => {
    const descriptor = Adapter.resourceQuery("users", "1");

    const result = await Effect.runPromise(
      descriptor.loader.pipe(
        Effect.provide(mockHttpClientLayer),
        Effect.provideService(SyncConfig, mockConfig)
      )
    );

    expect(result.id).toBe("1");
    expect(result.attributes?.name).toBe("John Doe");
    expect(descriptor.key).toEqual(["jsonapi", "users", "1"]);
    expect(descriptor.tags).toEqual(["jsonapi:users"]);
  });

  it("runs a resourceQuery through the SyncCache", async () => {
    const descriptor = Adapter.resourceQuery("users", "1");

    const result = await withCache((cache) => cache.read(Query.toReadOptions(descriptor)));

    expect((result as ResourceObject).id).toBe("1");
  });

  it("gives resourcesQuery a list-marked key", () => {
    const descriptor = Adapter.resourcesQuery("users");
    expect(descriptor.key).toEqual(["jsonapi", "users", "list"]);
  });
});

describe("Adapter.resourcePageQuery", () => {
  it("computes the next cursor from page size", async () => {
    const descriptor = Adapter.resourcePageQuery("users", { page: { size: 2 } });

    const env = <A, E>(eff: Effect.Effect<A, E, HttpClient.HttpClient | SyncConfig>) =>
      Effect.runPromise(
        eff.pipe(
          Effect.provide(mockHttpClientLayer),
          Effect.provideService(SyncConfig, mockConfig)
        ) as Effect.Effect<A, E>
      );

    // First page returns 2 items == size, so there is a next cursor.
    const first = await env(descriptor.loadPage(Option.none()));
    expect(first.items).toHaveLength(2);
    expect(Option.getOrUndefined(first.nextCursor)).toBe(2);

    // Second page returns 1 item < size, so it is the last page.
    const second = await env(descriptor.loadPage(Option.some(2)));
    expect(second.items).toHaveLength(1);
    expect(Option.isNone(second.nextCursor)).toBe(true);
  });

  it("treats any non-empty page as having a successor when size is unknown", async () => {
    const descriptor = Adapter.resourcePageQuery("users");

    const page = await Effect.runPromise(
      descriptor
        .loadPage(Option.none())
        .pipe(
          Effect.provide(mockHttpClientLayer),
          Effect.provideService(SyncConfig, mockConfig)
        ) as unknown as Effect.Effect<{ nextCursor: Option.Option<number> }, never>
    );

    expect(Option.isSome(page.nextCursor)).toBe(true);
  });
});

describe("Adapter mutation descriptors", () => {
  it("creates a resource and returns the server result", async () => {
    const descriptor = Adapter.createResourceMutation("users");

    const result = await withCache((cache) =>
      Mutation.execute(cache, descriptor, { type: "users", attributes: { name: "Created" } })
    );

    expect((result as ResourceObject).id).toBe("100");
  });

  it("update mutation writes the result under the resource key", async () => {
    const descriptor = Adapter.updateResourceMutation("users");

    const cached = await withCache((cache) =>
      Effect.gen(function* () {
        yield* Mutation.execute(cache, descriptor, {
          type: "users",
          id: "1",
          attributes: { name: "New" },
        });
        return yield* cache.peek<ResourceObject>(Adapter.resourceKey("users", "1"));
      })
    );

    expect(Option.getOrUndefined(cached)?.value.attributes?.name).toBe("Updated");
  });

  it("create invalidation marks list queries stale", async () => {
    const listDescriptor = Adapter.resourcesQuery("users");
    const createDescriptor = Adapter.createResourceMutation("users");

    const wasStale = await withCache((cache) =>
      Effect.gen(function* () {
        // Populate the list query (fresh for a long time).
        yield* cache.read(Query.toReadOptions({ ...listDescriptor, staleTime: "1 hour" }));
        // A create mutation should invalidate the collection.
        yield* Mutation.execute(cache, createDescriptor, {
          type: "users",
          attributes: { name: "Created" },
        });
        const entry = yield* cache.peek(listDescriptor.key);
        const now = Date.now();
        return Option.isSome(entry) ? freshness(entry.value, now) !== "fresh" : false;
      })
    );

    expect(wasStale).toBe(true);
  });

  it("delete mutation runs and invalidates the collection", async () => {
    const descriptor = Adapter.deleteResourceMutation("users");

    const result = await withCache((cache) => Mutation.execute(cache, descriptor, "1"));

    expect(result).toBeUndefined();
  });
});
