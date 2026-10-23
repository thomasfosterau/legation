/**
 * CrudMutation tests (ADR-0030 §5): the graph-derived CRUD mutations write
 * the graph row form, `update` merges and is a no-op on an absent row, and
 * `writes` selects which are derived.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CrudMutation from "../CrudMutation.js";
import * as Edge from "../Edge.js";
import type * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";

const products = Node.make("products", { attributes: { name: Schema.String } });
const reviews = Node.make("reviews", {
  attributes: { rating: Schema.Number, body: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const users = Node.make("users", { id: "username", attributes: { username: Schema.String } });
const nodes = Node.registry([products, reviews, users]);

/** A local writer over a plain map, keyed `collection/id`. */
const memoryWriter = () => {
  const rows = new Map<string, unknown>();
  const writer: Mutator.LocalWriter = {
    put: (collection, id, value) => Effect.sync(() => void rows.set(`${collection}/${id}`, value)),
    del: (collection, id) => Effect.sync(() => void rows.delete(`${collection}/${id}`)),
    get: (collection, id) => Effect.sync(() => rows.get(`${collection}/${id}`)),
  };
  return { rows, writer };
};

const run = (
  registry: Mutator.MutatorRegistry,
  mutator: string,
  args: unknown,
  writer: Mutator.LocalWriter
) => registry.handlers.get(mutator)!(args, writer);

describe("CrudMutation", () => {
  const registry = CrudMutation.registry(nodes);

  it("derives create, update and delete for every node", () => {
    expect([...registry.mutators.keys()].toSorted()).toEqual(
      [
        "products/create",
        "products/delete",
        "products/update",
        "reviews/create",
        "reviews/delete",
        "reviews/update",
        "users/create",
        "users/delete",
        "users/update",
      ].toSorted()
    );
  });

  it("restricts to the operations `writes` selects", () => {
    const some = CrudMutation.registry(nodes, { writes: { reviews: ["create"] } });
    expect([...some.mutators.keys()]).toEqual(["reviews/create"]);
  });

  it.effect("create puts the graph row form under the node's identity", () =>
    Effect.gen(function* () {
      const { rows, writer } = memoryWriter();
      yield* run(
        registry,
        "reviews/create",
        { type: "reviews", id: "r-1", attributes: { rating: 5, body: "Good", productId: "p-1" } },
        writer
      );
      expect(rows.get("reviews/r-1")).toEqual({
        id: "r-1",
        rating: 5,
        body: "Good",
        productId: "p-1",
      });
      yield* run(registry, "users/create", { type: "users", id: "ana", attributes: {} }, writer);
      expect(rows.get("users/ana")).toEqual({ username: "ana" });
    })
  );

  it.effect("update merges over the current row and is a no-op when the row is absent", () =>
    Effect.gen(function* () {
      const { rows, writer } = memoryWriter();
      yield* run(
        registry,
        "reviews/update",
        { type: "reviews", id: "r-1", attributes: { rating: 4 } },
        writer
      );
      expect(rows.has("reviews/r-1")).toBe(false);
      rows.set("reviews/r-1", { id: "r-1", rating: 5, body: "Good", productId: "p-1" });
      yield* run(
        registry,
        "reviews/update",
        { type: "reviews", id: "r-1", attributes: { rating: 4, productId: null } },
        writer
      );
      expect(rows.get("reviews/r-1")).toEqual({
        id: "r-1",
        rating: 4,
        body: "Good",
        productId: null,
      });
    })
  );

  it.effect("delete removes the row, and is a no-op when it is absent", () =>
    Effect.gen(function* () {
      const { rows, writer } = memoryWriter();
      rows.set("reviews/r-1", { id: "r-1" });
      yield* run(registry, "reviews/delete", { type: "reviews", id: "r-1" }, writer);
      yield* run(registry, "reviews/delete", { type: "reviews", id: "r-1" }, writer);
      expect(rows.has("reviews/r-1")).toBe(false);
    })
  );

  it("names a mutation `{type}/{operation}`", () => {
    expect(CrudMutation.name("reviews", "update")).toBe("reviews/update");
  });
});
