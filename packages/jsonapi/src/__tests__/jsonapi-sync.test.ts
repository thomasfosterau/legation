/**
 * JsonApiSync tests
 *
 * Convention discovery + an end-to-end client-direct sync against a stateful
 * in-memory JSON:API server (an HttpClient over an in-process resource
 * store): optimistic create is visible immediately, push writes through to
 * the API, and pull reflects authoritative state. Update and delete round
 * trip the same way.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ClientEngine, ClientStore, Subset } from "@legation/effect";
import * as Convention from "../Convention.js";
import * as JsonApiSync from "../JsonApiSync.js";

// A conventional JSON:API surface for one resource type, `todos`.
const idParam = { params: Schema.Struct({ id: Schema.String }) };
const body = { payload: Schema.Unknown, success: Schema.Unknown };
const api = HttpApi.make("app").add(
  HttpApiGroup.make("todos")
    .add(HttpApiEndpoint.get("list", "/todos", { success: Schema.Unknown }))
    .add(HttpApiEndpoint.get("getOne", "/todos/:id", { ...idParam, success: Schema.Unknown }))
    .add(HttpApiEndpoint.post("create", "/todos", body))
    .add(HttpApiEndpoint.patch("update", "/todos/:id", { ...idParam, ...body }))
    .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam))
);

interface StoredResource {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}

const headers = { "Content-Type": "application/vnd.api+json" };
const doc = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers });
const empty = (status: number) => new Response(null, { status, headers });
const readBody = (request: { readonly body: unknown }): any => {
  const b = request.body as { _tag?: string; body?: Uint8Array };
  return b?._tag === "Uint8Array" && b.body
    ? JSON.parse(new TextDecoder().decode(b.body))
    : undefined;
};

/** An in-memory JSON:API server exposed as an HttpClient. */
const makeServer = (forbidCreate?: (id: string) => boolean) => {
  const store = new Map<string, StoredResource>();

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const segments = url.pathname.split("/").filter((s) => s.length > 0);
      const id = segments.length > 1 ? segments[1] : undefined;
      let response: Response;
      switch (request.method) {
        case "GET":
          response =
            id === undefined
              ? doc([...store.values()])
              : store.has(id)
                ? doc(store.get(id))
                : empty(404);
          break;
        case "POST": {
          const resource = readBody(request).data as StoredResource;
          if (forbidCreate?.(resource.id)) {
            response = empty(403); // permanent rejection
            break;
          }
          store.set(resource.id, {
            type: resource.type,
            id: resource.id,
            attributes: resource.attributes ?? {},
          });
          response = doc(store.get(resource.id));
          break;
        }
        case "PATCH": {
          const patch = readBody(request).data as StoredResource;
          const existing = store.get(id!) ?? { type: "todos", id: id!, attributes: {} };
          const merged = {
            ...existing,
            attributes: { ...existing.attributes, ...patch.attributes },
          };
          store.set(id!, merged);
          response = doc(merged);
          break;
        }
        case "DELETE":
          store.delete(id!);
          response = empty(204);
          break;
        default:
          response = empty(405);
      }
      return HttpClientResponse.fromWeb(request, response);
    })
  );

  return { store, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

const titles = (rows: ReadonlyArray<{ readonly value: unknown }>): ReadonlyArray<string> =>
  rows.map((row) => (row.value as { title: string }).title);

describe("Convention.classify", () => {
  it("classifies conventional JSON:API routes", () => {
    expect(Convention.classify("GET", "/todos")).toEqual({ type: "todos", operation: "list" });
    expect(Convention.classify("GET", "/todos/:id")).toEqual({
      type: "todos",
      operation: "getOne",
    });
    expect(Convention.classify("POST", "/todos")).toEqual({ type: "todos", operation: "create" });
    expect(Convention.classify("PATCH", "/api/todos/:id")).toEqual({
      type: "todos",
      operation: "update",
    });
    expect(Convention.classify("DELETE", "/todos/:id")).toEqual({
      type: "todos",
      operation: "delete",
    });
  });

  it("ignores non-CRUD shapes", () => {
    expect(Convention.classify("POST", "/todos/:id")).toBeUndefined();
    expect(Convention.classify("GET", "/todos/:id/comments")).toBeUndefined();
    expect(Convention.classify("OPTIONS", "/todos")).toBeUndefined();
  });
});

describe("JsonApiSync.inspect", () => {
  it("discovers the resource, collection, and CRUD mutators", () => {
    const { resources, collections, registry, operations } = JsonApiSync.inspect(api);
    expect([...resources.keys()]).toEqual(["todos"]);
    expect(collections.map((c) => c.name)).toEqual(["todos"]);
    expect([...registry.mutators.keys()].toSorted()).toEqual([
      "todos/create",
      "todos/delete",
      "todos/update",
    ]);
    expect(operations.get("todos/create")).toEqual({ operation: "create", type: "todos" });
  });
});

describe("end-to-end client-direct sync", () => {
  it.effect("optimistic create is visible, then syncs through the API", () => {
    const server = makeServer();
    const todos = Subset.make({
      collection: "todos",
      orderBy: [{ field: "id", direction: "asc" }],
    });

    return Effect.gen(function* () {
      const engine = yield* ClientEngine.ClientEngine;
      yield* engine.subscribe(todos);

      // Optimistic create — visible before any network round trip.
      yield* engine.mutate("todos/create", {
        type: "todos",
        id: "1",
        attributes: { title: "first" },
      });
      expect(titles(yield* engine.query(todos))).toEqual(["first"]);

      // Sync: push writes through, pull reveals authoritative state.
      yield* engine.push;
      yield* engine.pull;
      expect(server.store.has("1")).toBe(true);
      expect(titles(yield* engine.query(todos))).toEqual(["first"]);

      // Update round trips.
      yield* engine.mutate("todos/update", {
        type: "todos",
        id: "1",
        attributes: { title: "edited" },
      });
      yield* engine.push;
      yield* engine.pull;
      expect(server.store.get("1")?.attributes.title).toBe("edited");
      expect(titles(yield* engine.query(todos))).toEqual(["edited"]);

      // A row created directly on the server arrives via pull.
      server.store.set("2", { type: "todos", id: "2", attributes: { title: "remote" } });
      yield* engine.pull;
      expect(titles(yield* engine.query(todos))).toEqual(["edited", "remote"]);

      // Delete round trips.
      yield* engine.mutate("todos/delete", { type: "todos", id: "2" });
      yield* engine.push;
      yield* engine.pull;
      expect(server.store.has("2")).toBe(false);
      expect(titles(yield* engine.query(todos))).toEqual(["edited"]);
    }).pipe(
      Effect.provide(
        JsonApiSync.layer(api, {
          baseUrl: "http://api.test",
          clientId: "client-1",
          clientGroupId: "group-1",
        }).pipe(Layer.provide(server.layer))
      ),
      Effect.scoped
    );
  });

  it.effect("a 4xx create is permanently rejected without poisoning the queue", () => {
    // The server forbids creating "x"; the create behind it must still land.
    const server = makeServer((id) => id === "x");
    const todos = Subset.make({
      collection: "todos",
      orderBy: [{ field: "id", direction: "asc" }],
    });

    return Effect.gen(function* () {
      const engine = yield* ClientEngine.ClientEngine;
      yield* engine.subscribe(todos);

      yield* engine.mutate("todos/create", {
        type: "todos",
        id: "x",
        attributes: { title: "doomed" },
      });
      yield* engine.mutate("todos/create", {
        type: "todos",
        id: "y",
        attributes: { title: "kept" },
      });
      // Both are optimistically visible.
      expect(titles(yield* engine.query(todos))).toEqual(["doomed", "kept"]);

      // Push succeeds (the 403 is a permanent rejection, not a transport error);
      // the journal drains without app intervention.
      yield* engine.push;
      yield* engine.pull;

      // The forbidden create left no server row and its optimistic effect is
      // gone; the create queued behind it applied.
      expect(server.store.has("x")).toBe(false);
      expect(server.store.has("y")).toBe(true);
      expect(titles(yield* engine.query(todos))).toEqual(["kept"]);
    }).pipe(
      Effect.provide(
        JsonApiSync.layer(api, {
          baseUrl: "http://api.test",
          clientId: "client-1",
          clientGroupId: "group-1",
        }).pipe(Layer.provide(server.layer))
      ),
      Effect.scoped
    );
  });
});

describe("JsonApiSync.layer store option", () => {
  it.effect("writes through a supplied durable client store", () => {
    const server = makeServer();
    return Effect.gen(function* () {
      // The app's own store instance, injected via the new `store` option —
      // journalled mutations must land in it (offline durability seam).
      const appStore = yield* ClientStore.makeMemory;
      yield* Effect.gen(function* () {
        const engine = yield* ClientEngine.ClientEngine;
        yield* engine.mutate("todos/create", {
          type: "todos",
          id: "1",
          attributes: { title: "queued" },
        });
      }).pipe(
        Effect.provide(
          JsonApiSync.layer(api, {
            baseUrl: "http://api.test",
            clientId: "client-1",
            clientGroupId: "group-1",
            store: Layer.succeed(ClientStore.ClientStore)(appStore),
          }).pipe(Layer.provide(server.layer))
        )
      );
      expect((yield* appStore.pendingMutations).map((m) => m.mutator)).toEqual(["todos/create"]);
    }).pipe(Effect.scoped);
  });
});
