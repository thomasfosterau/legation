/**
 * SpecExport tests: emitting OpenAPI / AsyncAPI descriptions of a sync surface.
 * The focus is specialization — that an app's collections, mutators and queries
 * become concrete, per-name component schemas in the generic protocol envelope —
 * and that both projections are structurally well-formed.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Collection from "../Collection.js";
import * as Mutator from "../Mutator.js";
import * as Query from "../Query.js";
import * as SpecExport from "../SpecExport.js";

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  isDone: Schema.Boolean,
});

const todos = Collection.make({ name: "todos", schema: Todo, id: (t) => t.id });
const setTodo = Mutator.make("todo/set", Todo);
const removeTodo = Mutator.make("todo/remove", Schema.Struct({ id: Schema.String }));
const byDone = Query.make("todos/byDone", Schema.Struct({ isDone: Schema.Boolean }));

const api: SpecExport.SyncApi = {
  info: { title: "Todo Sync", version: "1.0.0" },
  collections: [todos],
  mutators: [setTodo, removeTodo],
  queries: [byDone],
  path: "/sync",
};

// The parts of the emitted documents these tests read.
const decodePutComponent = Schema.decodeUnknownSync(
  Schema.Struct({ properties: Schema.Struct({ value: Schema.Unknown }) })
);
const decodeOpenApi = Schema.decodeUnknownSync(
  Schema.Struct({
    openapi: Schema.String,
    paths: Schema.Record(
      Schema.String,
      Schema.Struct({ post: Schema.Struct({ operationId: Schema.String }) })
    ),
    components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Unknown) }),
  })
);
const decodePaths = Schema.decodeUnknownSync(
  Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) })
);
const decodeAsyncApi = Schema.decodeUnknownSync(
  Schema.Struct({
    asyncapi: Schema.String,
    channels: Schema.Record(Schema.String, Schema.Unknown),
    operations: Schema.Record(Schema.String, Schema.Struct({ action: Schema.String })),
    components: Schema.Struct({ messages: Schema.Record(Schema.String, Schema.Unknown) }),
  })
);

describe("SpecExport.build", () => {
  it("specializes the protocol with per-name component schemas", () => {
    const spec = SpecExport.build(api);
    const keys = R.keys(spec.components);

    // Each app type gets a named, sanitized component.
    expect(keys).toContain("Row_todos");
    expect(keys).toContain("MutatorArgs_todo_set");
    expect(keys).toContain("MutatorArgs_todo_remove");
    expect(keys).toContain("QueryArgs_todos_byDone");

    // Mutation is a discriminated union over the mutators.
    expect(spec.components["Mutation"]).toEqual({
      anyOf: [
        { $ref: "#/components/schemas/Mutation_todo_set" },
        { $ref: "#/components/schemas/Mutation_todo_remove" },
      ],
    });

    // The catalog points at the real component names.
    expect(spec.catalog.collections).toEqual([{ name: "todos", schema: "Row_todos" }]);
    expect(spec.catalog.mutators.map((m) => m.name)).toEqual(["todo/set", "todo/remove"]);
    expect(spec.catalog.queries).toEqual([
      { name: "todos/byDone", schema: "QueryArgs_todos_byDone" },
    ]);
  });

  it("describes the row value on a patch Put with the collection's schema", () => {
    const spec = SpecExport.build(api);
    const put = decodePutComponent(spec.components["Put_todos"]);
    expect(put.properties.value).toEqual({ $ref: "#/components/schemas/Row_todos" });
  });

  it("falls back to the generic envelope when nothing is supplied", () => {
    const spec = SpecExport.build({ info: { title: "Empty", version: "0.0.0" } });
    expect(spec.path).toBe("/sync");
    expect(R.keys(spec.components)).toContain("PushRequest");
    expect(spec.catalog).toEqual({ collections: [], mutators: [], queries: [] });
  });
});

describe("SpecExport.toOpenApi", () => {
  it("emits push/pull operations at the configured path", () => {
    const doc = decodeOpenApi(SpecExport.openApi(api));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/sync/push"].post.operationId).toBe("push");
    expect(doc.paths["/sync/pull"].post.operationId).toBe("pull");
    expect(doc.components.schemas["Row_todos"]).toBeDefined();
  });

  it("honours a custom path", () => {
    const doc = decodePaths(SpecExport.openApi({ ...api, path: "/api/v2/sync" }));
    expect(R.keys(doc.paths)).toEqual(["/api/v2/sync/push", "/api/v2/sync/pull"]);
  });
});

describe("SpecExport.toAsyncApi", () => {
  it("emits push/pull/poke channels and operations", () => {
    const doc = decodeAsyncApi(SpecExport.asyncApi(api));
    expect(doc.asyncapi).toBe("3.0.0");
    expect(Arr.sort(R.keys(doc.channels), Order.String)).toEqual(["pokes", "pull", "push"]);
    expect(doc.operations.receivePokes.action).toBe("receive");
    expect(doc.operations.push.action).toBe("send");
    expect(doc.components.messages["Poke"]).toBeDefined();
  });
});
