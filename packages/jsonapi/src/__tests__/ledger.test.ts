/**
 * Ledger stores (#468): the in-memory default and the key/value store adapter.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { KeyValueStore } from "effect/persistence";
import { BackendError, type Backend } from "@thomasfosterau/legation-effect";
import * as JsonApiBackend from "../JsonApiBackend.js";
import * as JsonApiSync from "../JsonApiSync.js";
import * as Ledger from "../Ledger.js";

const group: Ledger.GroupLedger = {
  lastMutationIds: { "client-1": 3, "client-2": 1 },
  rejections: [{ clientId: "client-1", mutationId: 2, reason: "title taken" }],
};

describe("Ledger.memory", () => {
  it.effect("reads an empty group and persists nothing", () =>
    Effect.gen(function* () {
      expect(yield* Ledger.memory.read("g")).toEqual(Ledger.emptyGroup);
      yield* Ledger.memory.write("g", group);
      expect(yield* Ledger.memory.read("g")).toEqual(Ledger.emptyGroup);
    })
  );
});

describe("Ledger.keyValue", () => {
  it.effect("reads an unknown group as empty", () =>
    Effect.gen(function* () {
      const store = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      expect(yield* store.read("never-written")).toEqual(Ledger.emptyGroup);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("round-trips a group, keeping each group under its own key", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = Ledger.keyValue(kv);
      yield* store.write("g", group);
      expect(yield* store.read("g")).toEqual(group);
      expect(yield* store.read("other")).toEqual(Ledger.emptyGroup);
      expect(yield* kv.has("legation-jsonapi:ledger:g")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("refuses a stored value that does not decode, rather than reading it as empty", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set("legation-jsonapi:ledger:g", "{not json");
      const store = Ledger.keyValue(kv);
      const notJson = yield* Effect.flip(store.read("g"));
      expect(notJson).toBeInstanceOf(BackendError);
      yield* kv.set("legation-jsonapi:ledger:g", JSON.stringify({ lastMutationIds: { a: "x" } }));
      const notLedger = yield* Effect.flip(store.read("g"));
      expect(notLedger).toBeInstanceOf(BackendError);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});

/**
 * The forgetting bound on the backend (#475, as MemoryBackend's #355): a
 * rejection at exactly a push's floor is still reported, because the push does
 * not start past it, and it stops being reported once a push starts past it.
 * The per-resource server refuses every update and delete with a 422.
 */
const idParam = { params: Schema.Struct({ id: Schema.String }) };
const boundApi = HttpApi.make("app").add(
  HttpApiGroup.make("todos")
    .add(HttpApiEndpoint.get("getOne", "/todos/:id", { ...idParam, success: Schema.Unknown }))
    .add(
      HttpApiEndpoint.post("create", "/todos", {
        payload: Schema.Unknown,
        success: Schema.Unknown,
      })
    )
    .add(
      HttpApiEndpoint.patch("update", "/todos/:id", {
        ...idParam,
        payload: Schema.Unknown,
        success: Schema.Unknown,
      })
    )
    .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam))
);
const boundInspected = JsonApiSync.inspect(boundApi);

const refusingServer = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const id = url.pathname.match(/^\/todos\/([^/]+)$/)?.[1];
    const json = (status: number, document: unknown) =>
      new Response(JSON.stringify(document), {
        status,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    if (request.method === "GET" && id !== undefined)
      return HttpClientResponse.fromWeb(
        request,
        json(200, { data: { type: "todos", id, attributes: { title: "stored" } } })
      );
    if (request.method === "PATCH" || request.method === "DELETE")
      return HttpClientResponse.fromWeb(
        request,
        json(422, { errors: [{ title: "Refused", detail: "no" }] })
      );
    return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
  })
);

const boundMutation = (mutationId: number, mutator: string, args: unknown) => ({
  clientId: "client-1",
  mutationId,
  mutator,
  args,
  createdAt: 0,
});

describe("JsonApiBackend rejection memory bound (#475)", () => {
  it.effect("a rejection at a push's floor is kept, and forgotten once a push starts past it", () =>
    Effect.gen(function* () {
      const backend = yield* JsonApiBackend.make({
        baseUrl: "http://api.test",
        resources: boundInspected.resources,
        mutators: boundInspected.registry.mutators,
        operations: boundInspected.operations,
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(refusingServer)));
      const context: Backend.SyncContext = { clientGroupId: "group-1" };
      const update = boundMutation(1, "todos/update", {
        type: "todos",
        id: "1",
        attributes: { title: "x" },
      });
      const create = (mutationId: number, id: string) =>
        boundMutation(mutationId, "todos/create", {
          type: "todos",
          id,
          attributes: { title: id },
        });

      const first = yield* backend.applyMutations(context, [update]);
      expect(first.rejected?.map((entry) => entry.mutationId)).toEqual([1]);

      // A push whose lowest id is 1, the rejection's own id, does not start past it.
      const atFloor = yield* backend.applyMutations(context, [update, create(2, "4")]);
      expect(atFloor.rejected).toEqual(first.rejected);
      expect(atFloor.lastMutationIds).toEqual({ "client-1": 2 });

      // A push whose lowest id is 3 passes 1, so a copy of 1 is no longer reported.
      yield* backend.applyMutations(context, [create(3, "5")]);
      const late = yield* backend.applyMutations(context, [update]);
      expect(late.rejected).toBeUndefined();
      expect(late.lastMutationIds).toEqual({ "client-1": 3 });
    })
  );
});
