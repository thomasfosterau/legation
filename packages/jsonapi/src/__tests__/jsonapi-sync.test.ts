/**
 * JsonApiSync tests
 *
 * Convention discovery + an end-to-end client-direct sync against a stateful
 * in-memory JSON:API server (an HttpClient over an in-process resource
 * store): optimistic create is visible immediately, push writes through to
 * the API, and pull reflects authoritative state. Update and delete round
 * trip the same way.
 */
import { describe, describeWrapped, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { KeyValueStore } from "effect/persistence";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Str from "effect/String";
import { ClientStore, StoreError } from "@thomasfosterau/legation";
import { ClientEngine, Subset, Protocol } from "@thomasfosterau/legation/internal";
import * as Convention from "../Convention.js";
import * as JsonApiSync from "../JsonApiSync.js";
import * as Ledger from "../Ledger.js";
import { defined } from "./defined.js";
import { withLayer } from "./with-layer.js";

const decodeTitled = Schema.decodeUnknownSync(Schema.Struct({ title: Schema.String }));

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);

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
  readonly attributes: Record<string, Schema.Json>;
}

const headers = { "Content-Type": "application/vnd.api+json" };
const doc = (data: unknown) => new Response(encodeJson({ data }), { status: 200, headers });
const empty = (status: number) => new Response(null, { status, headers });
const decodeResourceDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        type: Schema.String,
        id: Schema.String,
        attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      }),
    })
  )
);
/** The primary resource of a request's JSON:API document. */
const readResource = (request: HttpClientRequest.HttpClientRequest) =>
  decodeResourceDocument(
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
  ).data;

/** An in-memory JSON:API server exposed as an HttpClient. */
const makeServer = (forbidCreate?: (id: string) => boolean) => {
  const store = MutableHashMap.empty<string, StoredResource>();

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const segments = url.pathname.split("/").filter((s) => Str.isNonEmpty(s));
      const id = segments.length > 1 ? segments[1] : undefined;
      const response: Response = Match.value(request.method).pipe(
        Match.withReturnType<Response>(),
        Match.when("GET", () =>
          id === undefined
            ? doc([...MutableHashMap.values(store)])
            : MutableHashMap.has(store, id)
              ? doc(Option.getOrUndefined(MutableHashMap.get(store, id)))
              : empty(404)
        ),
        Match.when("POST", () => {
          const resource = readResource(request);
          if (forbidCreate?.(resource.id)) {
            return empty(403); // permanent rejection
          }
          MutableHashMap.set(store, resource.id, {
            type: resource.type,
            id: resource.id,
            attributes: resource.attributes ?? {},
          });
          return doc(Option.getOrUndefined(MutableHashMap.get(store, resource.id)));
        }),
        Match.when("PATCH", () => {
          const patch = readResource(request);
          const existing = Option.getOrUndefined(MutableHashMap.get(store, defined(id))) ?? {
            type: "todos",
            id: defined(id),
            attributes: {},
          };
          const merged = {
            ...existing,
            attributes: { ...existing.attributes, ...patch.attributes },
          };
          MutableHashMap.set(store, defined(id), merged);
          return doc(merged);
        }),
        Match.when("DELETE", () => {
          MutableHashMap.remove(store, defined(id));
          return empty(204);
        }),
        Match.orElse(() => empty(405))
      );
      return HttpClientResponse.fromWeb(request, response);
    })
  );

  return { store, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

const titles = (rows: ReadonlyArray<{ readonly value: unknown }>): ReadonlyArray<string> =>
  rows.map((row) => decodeTitled(row.value).title);

describeWrapped("Convention.classify", (it) => {
  it("classifies conventional JSON:API routes", () => {
    expect(Convention.classify("GET", "/todos")).toEqual(
      Option.some({ type: "todos", operation: "list" })
    );
    expect(Convention.classify("GET", "/todos/:id")).toEqual(
      Option.some({
        type: "todos",
        operation: "getOne",
      })
    );
    expect(Convention.classify("POST", "/todos")).toEqual(
      Option.some({ type: "todos", operation: "create" })
    );
    expect(Convention.classify("PATCH", "/api/todos/:id")).toEqual(
      Option.some({
        type: "todos",
        operation: "update",
      })
    );
    expect(Convention.classify("DELETE", "/todos/:id")).toEqual(
      Option.some({
        type: "todos",
        operation: "delete",
      })
    );
  });

  it("ignores non-CRUD shapes", () => {
    expect(Convention.classify("POST", "/todos/:id")).toEqual(Option.none());
    expect(Convention.classify("GET", "/todos/:id/comments")).toEqual(Option.none());
    expect(Convention.classify("OPTIONS", "/todos")).toEqual(Option.none());
  });
});

describeWrapped("JsonApiSync.inspect", (it) => {
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
  {
    const server = makeServer();
    const todos = Subset.make({
      collection: "todos",
      orderBy: [{ field: "id", direction: "asc" }],
    });

    layer(
      JsonApiSync.layer(api, {
        baseUrl: "http://api.test",
        clientId: "client-1",
        clientGroupId: Protocol.ClientGroupId.make("group-1"),
      }).pipe(Layer.provide(server.layer))
    )((scoped) => {
      scoped.effect("optimistic create is visible, then syncs through the API", () =>
        Effect.gen(function* () {
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
          expect(MutableHashMap.has(server.store, "1")).toBe(true);
          expect(titles(yield* engine.query(todos))).toEqual(["first"]);

          // Update round trips.
          yield* engine.mutate("todos/update", {
            type: "todos",
            id: "1",
            attributes: { title: "edited" },
          });
          yield* engine.push;
          yield* engine.pull;
          expect(
            Option.getOrUndefined(MutableHashMap.get(server.store, "1"))?.attributes.title
          ).toBe("edited");
          expect(titles(yield* engine.query(todos))).toEqual(["edited"]);

          // A row created directly on the server arrives via pull.
          MutableHashMap.set(server.store, "2", {
            type: "todos",
            id: "2",
            attributes: { title: "remote" },
          });
          yield* engine.pull;
          expect(titles(yield* engine.query(todos))).toEqual(["edited", "remote"]);

          // Delete round trips.
          yield* engine.mutate("todos/delete", { type: "todos", id: "2" });
          yield* engine.push;
          yield* engine.pull;
          expect(MutableHashMap.has(server.store, "2")).toBe(false);
          expect(titles(yield* engine.query(todos))).toEqual(["edited"]);
        })
      );
    });
  }

  {
    // The server forbids creating "x"; the create behind it must still land.
    const server = makeServer((id) => id === "x");
    const todos = Subset.make({
      collection: "todos",
      orderBy: [{ field: "id", direction: "asc" }],
    });

    layer(
      JsonApiSync.layer(api, {
        baseUrl: "http://api.test",
        clientId: "client-1",
        clientGroupId: Protocol.ClientGroupId.make("group-1"),
      }).pipe(Layer.provide(server.layer))
    )((scoped) => {
      scoped.effect("a 4xx create is permanently rejected without poisoning the queue", () =>
        Effect.gen(function* () {
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
          expect(MutableHashMap.has(server.store, "x")).toBe(false);
          expect(MutableHashMap.has(server.store, "y")).toBe(true);
          expect(titles(yield* engine.query(todos))).toEqual(["kept"]);
        })
      );
    });
  }
});

describeWrapped("JsonApiSync.layer store option", (it) => {
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
        withLayer(
          JsonApiSync.layer(api, {
            baseUrl: "http://api.test",
            clientId: "client-1",
            clientGroupId: Protocol.ClientGroupId.make("group-1"),
            store: Layer.succeed(ClientStore.ClientStore)(appStore),
          }).pipe(Layer.provide(server.layer))
        )
      );
      expect((yield* appStore.pendingMutations).map((m) => m.mutator)).toEqual(["todos/create"]);
    }).pipe(Effect.scoped);
  });

  it.effect("fails with the StoreError of a store that cannot open", () => {
    const server = makeServer();
    const failure = new StoreError({ message: "Failed to open the IndexedDB store" });
    return Effect.gen(function* () {
      const error = yield* Layer.build(
        JsonApiSync.layer(api, {
          baseUrl: "http://api.test",
          clientId: "client-1",
          clientGroupId: Protocol.ClientGroupId.make("group-1"),
          store: Layer.effect(ClientStore.ClientStore)(Effect.fail(failure)),
        }).pipe(Layer.provide(server.layer))
      ).pipe(Effect.flip);
      expect(error).toBe(failure);
    }).pipe(Effect.scoped);
  });
});

describe("JsonApiSync.layer ledger default", () => {
  const todoCreate = {
    type: "todos",
    id: "1",
    attributes: { title: "queued" },
  };

  layer(KeyValueStore.layerMemory)((scoped) => {
    scoped.effect("writes the ledger to keyValueStore when no ledger is given", () => {
      const server = makeServer();
      return Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        yield* Effect.gen(function* () {
          const engine = yield* ClientEngine.ClientEngine;
          yield* engine.mutate("todos/create", todoCreate);
          yield* engine.push;
        }).pipe(
          withLayer(
            JsonApiSync.layer(api, {
              baseUrl: "http://api.test",
              clientId: "client-1",
              clientGroupId: Protocol.ClientGroupId.make("group-1"),
              keyValueStore: kv,
            }).pipe(Layer.provide(server.layer))
          ),
          Effect.scoped
        );
        // The push acknowledged mutation 1, and the ledger is in the store, not in memory alone.
        expect(yield* Ledger.keyValue(kv).read("group-1")).toEqual({
          lastMutationIds: { "client-1": 1 },
          rejections: [],
        });
      });
    });
  });

  layer(KeyValueStore.layerMemory)((scoped) => {
    scoped.effect(
      "a reload with keyValueStore alone reaches the server with its next mutation",
      () => {
        const server = makeServer();
        const mutate = (kv: KeyValueStore.KeyValueStore, id: string, title: string) =>
          Effect.gen(function* () {
            const engine = yield* ClientEngine.ClientEngine;
            yield* engine.mutate("todos/create", { type: "todos", id, attributes: { title } });
            yield* engine.push;
          }).pipe(
            withLayer(
              JsonApiSync.layer(api, {
                baseUrl: "http://api.test",
                clientId: "client-1",
                clientGroupId: Protocol.ClientGroupId.make("group-1"),
                keyValueStore: kv,
              }).pipe(Layer.provide(server.layer))
            ),
            Effect.scoped
          );
        return Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          yield* mutate(kv, "1", "first");
          // A reload: a new layer over the same key/value store, with no `store` given. The
          // ledger acknowledged mutation 1, so a counter that restarted at 1 would skip this one.
          yield* mutate(kv, "2", "second");
          expect(
            Option.getOrUndefined(MutableHashMap.get(server.store, "2"))?.attributes.title
          ).toBe("second");
          expect(yield* Ledger.keyValue(kv).read("group-1")).toEqual({
            lastMutationIds: { "client-1": 2 },
            rejections: [],
          });
        });
      }
    );
  });

  layer(KeyValueStore.layerMemory)((scoped) => {
    scoped.effect("an explicit ledger overrides the key/value store", () => {
      const server = makeServer();
      return Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        yield* Effect.gen(function* () {
          const engine = yield* ClientEngine.ClientEngine;
          yield* engine.mutate("todos/create", todoCreate);
          yield* engine.push;
        }).pipe(
          withLayer(
            JsonApiSync.layer(api, {
              baseUrl: "http://api.test",
              clientId: "client-1",
              clientGroupId: Protocol.ClientGroupId.make("group-1"),
              keyValueStore: kv,
              ledger: Ledger.memory,
            }).pipe(Layer.provide(server.layer))
          ),
          Effect.scoped
        );
        expect(yield* kv.has("legation-jsonapi:ledger:group-1")).toBe(false);
      });
    });
  });
});
