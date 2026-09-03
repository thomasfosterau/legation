/**
 * Unit tests for `CollectionIndex.ts` (issue #113): hash/ordered maintenance,
 * the And-conjunct planner, and the ClientEngine-level integration — declared
 * indexes, `autoIndex` discovery, the pending-journal fallback, and Put/Del/
 * Clear consistency across a pull.
 */
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as CollectionIndex from "../CollectionIndex.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import type { PullResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

// ─── CollectionIndex (pure module) ───────────────────────────────────────────

const row = (id: string, value: unknown) => ({ id, value });

describe("CollectionIndex", () => {
  it("rebuild + upsertRow + deleteRow maintain hash buckets", () => {
    const index = CollectionIndex.empty(["done"]);
    CollectionIndex.rebuild(index, [
      row("a", { done: true }),
      row("b", { done: false }),
      row("c", { done: true }),
    ]);
    expect(
      CollectionIndex.evaluate(
        index,
        new Map([
          ["a", row("a", { done: true })],
          ["b", row("b", { done: false })],
          ["c", row("c", { done: true })],
        ]),
        Predicate.eq("done", true)
      )
        ?.map((r) => r.id)
        .toSorted()
    ).toEqual(["a", "c"]);

    CollectionIndex.upsertRow(index, "b", { done: true });
    const rowsById = new Map([
      ["a", row("a", { done: true })],
      ["b", row("b", { done: true })],
      ["c", row("c", { done: true })],
    ]);
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.eq("done", true))
        ?.map((r) => r.id)
        .toSorted()
    ).toEqual(["a", "b", "c"]);

    CollectionIndex.deleteRow(index, "c");
    const afterDelete = new Map([
      ["a", row("a", { done: true })],
      ["b", row("b", { done: true })],
    ]);
    expect(
      CollectionIndex.evaluate(index, afterDelete, Predicate.eq("done", true))
        ?.map((r) => r.id)
        .toSorted()
    ).toEqual(["a", "b"]);
  });

  it("clear drops every indexed row", () => {
    const index = CollectionIndex.empty(["n"]);
    CollectionIndex.rebuild(index, [row("a", { n: 1 }), row("b", { n: 2 })]);
    CollectionIndex.clear(index);
    expect(CollectionIndex.evaluate(index, new Map(), Predicate.eq("n", 1))).toEqual([]);
  });

  it("range queries (gt/gte/lt/lte) match over a number field", () => {
    const index = CollectionIndex.empty(["n"]);
    const rows = [1, 2, 3, 4, 5].map((n) => row(`r${n}`, { n }));
    CollectionIndex.rebuild(index, rows);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const idsFor = (where: Predicate.Predicate) =>
      CollectionIndex.evaluate(index, rowsById, where)
        ?.map((r) => r.id)
        .toSorted();
    expect(idsFor(Predicate.gt("n", 3))).toEqual(["r4", "r5"]);
    expect(idsFor(Predicate.gte("n", 3))).toEqual(["r3", "r4", "r5"]);
    expect(idsFor(Predicate.lt("n", 3))).toEqual(["r1", "r2"]);
    expect(idsFor(Predicate.lte("n", 3))).toEqual(["r1", "r2", "r3"]);
  });

  it("`In` unions hash buckets across values", () => {
    const index = CollectionIndex.empty(["tag"]);
    const rows = [row("a", { tag: "x" }), row("b", { tag: "y" }), row("c", { tag: "z" })];
    CollectionIndex.rebuild(index, rows);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.isIn("tag", ["x", "z"]))
        ?.map((r) => r.id)
        .toSorted()
    ).toEqual(["a", "c"]);
  });

  it("an absent field and an explicit null share the NULL bucket (ADR-0028)", () => {
    const index = CollectionIndex.empty(["a"]);
    const rows = [row("absent", {}), row("null", { a: null }), row("one", { a: 1 })];
    CollectionIndex.rebuild(index, rows);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    // ADR-0028 rule (b): absent ≡ NULL. This assertion used to expect only
    // `["null"]` when the two indexed in separate buckets; `eq("a", null)`
    // now desugars to `IsNull`, which reads the shared bucket.
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.eq("a", null))?.map((r) => r.id)
    ).toEqual(["absent", "null"]);
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.isNull("a"))?.map((r) => r.id)
    ).toEqual(["absent", "null"]);
    // `IS NOT NULL` is the complement of a bucket: not narrowing, residual.
    expect(CollectionIndex.plan(index, Predicate.isNotNull("a"))).toBeUndefined();
    // A wire `Compare` carrying `null` is unknown for every row (ADR-0028 §5).
    expect(CollectionIndex.evaluate(index, rowsById, Predicate.compare("eq", "a", null))).toEqual(
      []
    );
    // Range and membership lookups never return the NULL bucket.
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.gte("a", 0))?.map((r) => r.id)
    ).toEqual(["one"]);
    expect(
      CollectionIndex.evaluate(index, rowsById, Predicate.isIn("a", [1, null]))?.map((r) => r.id)
    ).toEqual(["one"]);
  });

  it("orders boolean ranges false < true and text by code point (ADR-0028)", () => {
    const index = CollectionIndex.empty(["b", "s"]);
    const rows = [
      row("t", { b: true, s: "😀" }),
      row("f", { b: false, s: "￿" }),
      row("n", { s: "a" }),
    ];
    CollectionIndex.rebuild(index, rows);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const ids = (where: Predicate.Predicate) =>
      CollectionIndex.evaluate(index, rowsById, where)
        ?.map((r) => r.id)
        .toSorted();
    expect(ids(Predicate.gt("b", false))).toEqual(["t"]);
    expect(ids(Predicate.lte("b", false))).toEqual(["f"]);
    expect(ids(Predicate.gte("b", false))).toEqual(["f", "t"]);
    // U+FFFF sorts below U+1F600 by code point; JS `<` would say the reverse.
    expect(ids(Predicate.gt("s", "￿"))).toEqual(["t"]);
    expect(ids(Predicate.lt("s", "😀"))).toEqual(["f", "n"]);
  });

  it("plan returns undefined (full-scan fallback) when nothing is indexable", () => {
    const index = CollectionIndex.empty(["a"]);
    // `ne` never narrows, and the field isn't even indexed here.
    expect(CollectionIndex.plan(index, Predicate.ne("a", 1))).toBeUndefined();
    expect(CollectionIndex.plan(index, Predicate.eq("unindexed", 1))).toBeUndefined();
    expect(
      CollectionIndex.plan(index, Predicate.or(Predicate.eq("a", 1), Predicate.eq("a", 2)))
    ).toBeUndefined();
  });

  it("plan narrows on indexable conjuncts and pushes the rest to residual", () => {
    const index = CollectionIndex.empty(["a"]);
    CollectionIndex.rebuild(index, [row("x", { a: 1, b: true }), row("y", { a: 1, b: false })]);
    const found = CollectionIndex.plan(
      index,
      Predicate.and(Predicate.eq("a", 1), Predicate.eq("b", true))
    );
    expect(found).toBeDefined();
    expect([...found!.candidateIds].toSorted()).toEqual(["x", "y"]); // narrowed by `a` alone
    expect(found!.residual).toEqual(Predicate.eq("b", true)); // `b` isn't indexed here
  });
});

// ─── ClientEngine integration ────────────────────────────────────────────────

interface Item {
  readonly id: string;
  readonly priority: number;
  readonly done: boolean;
}

const setItem = Mutator.registry([
  {
    mutator: Mutator.make("item/set", Schema.Unknown),
    local: (args, writer) => writer.put("items", (args as Item).id, args),
  },
]);

interface User {
  readonly id: string;
  readonly name: string;
}

const setItemAndUser = Mutator.registry([
  {
    mutator: Mutator.make("item/set", Schema.Unknown),
    local: (args, writer) => writer.put("items", (args as Item).id, args),
  },
  {
    mutator: Mutator.make("user/set", Schema.Unknown),
    local: (args, writer) => writer.put("users", (args as User).id, args),
  },
]);

const noopHandler: ServerHandler = {
  handlePush: () => Effect.succeed({ lastMutationIds: {} }),
  handlePull: () => Effect.succeed({ patch: [], cookie: "c", lastMutationIds: {} }),
  handleRead: () => Effect.succeed({ rows: [] }),
  pokes: () => Stream.empty,
};

const items = (n: number): ReadonlyArray<Item> =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, priority: i % 5, done: i % 2 === 0 }));

const seedEngine = (engine: ClientEngineModule.ClientEngine, rows: ReadonlyArray<Item>) =>
  engine.seed(rows.map((item) => ({ collection: "items", id: item.id, version: 1, value: item })));

describe("ClientEngine + CollectionIndex", () => {
  it.effect("declared indexes: eq/In/range queries match an unindexed baseline", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(noopHandler, "g");
      const engine = yield* ClientEngineModule.make({
        clientId: "c",
        clientGroupId: "g",
        mutators: setItem,
        indexes: { items: ["priority"] },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      const rows = items(200);
      yield* seedEngine(engine, rows);

      const eq = yield* engine.query(
        Subset.make({ collection: "items", where: Predicate.eq("priority", 3) })
      );
      expect(eq.map((r) => r.id).toSorted()).toEqual(
        rows
          .filter((r) => r.priority === 3)
          .map((r) => r.id)
          .toSorted()
      );

      const inQuery = yield* engine.query(
        Subset.make({ collection: "items", where: Predicate.isIn("priority", [0, 4]) })
      );
      expect(inQuery.map((r) => r.id).toSorted()).toEqual(
        rows
          .filter((r) => r.priority === 0 || r.priority === 4)
          .map((r) => r.id)
          .toSorted()
      );

      const range = yield* engine.query(
        Subset.make({ collection: "items", where: Predicate.gte("priority", 3) })
      );
      expect(range.map((r) => r.id).toSorted()).toEqual(
        rows
          .filter((r) => r.priority >= 3)
          .map((r) => r.id)
          .toSorted()
      );
    })
  );

  it.effect(
    "autoIndex discovers a field from a queried predicate and stays correct as rows grow",
    () =>
      Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const transport = yield* makeInMemory(noopHandler, "g");
        const engine = yield* ClientEngineModule.make({
          clientId: "c",
          clientGroupId: "g",
          mutators: setItem,
          autoIndex: true,
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, transport)
        );

        yield* seedEngine(engine, items(50));
        const done = Predicate.eq("done", true);
        const first = yield* engine.query(Subset.make({ collection: "items", where: done }));
        expect(first.every((r) => (r.value as Item).done)).toBe(true);

        // Widen the collection after the field was auto-indexed; the index must
        // rebuild to cover the new rows, not serve a stale snapshot.
        yield* seedEngine(engine, items(80).slice(50));
        const second = yield* engine.query(Subset.make({ collection: "items", where: done }));
        expect(second.map((r) => r.id).toSorted()).toEqual(
          items(80)
            .filter((r) => r.done)
            .map((r) => r.id)
            .toSorted()
        );
      })
  );

  it.effect(
    "a pending mutation on the collection falls back to a correct (overlay-aware) scan",
    () =>
      Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        const transport = yield* makeInMemory(noopHandler, "g");
        const engine = yield* ClientEngineModule.make({
          clientId: "c",
          clientGroupId: "g",
          mutators: setItem,
          indexes: { items: ["done"] },
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, transport)
        );

        yield* seedEngine(engine, items(20)); // confirmed: even ids are done=true
        // Prime the index against the confirmed snapshot.
        yield* engine.query(
          Subset.make({ collection: "items", where: Predicate.eq("done", true) })
        );

        // Optimistically flip a `done: false` row to `done: true` — the index
        // (confirmed-only) doesn't know this yet; the journal is now non-empty.
        yield* engine.mutate("item/set", { id: "i1", priority: 1, done: true });

        const result = yield* engine.query(
          Subset.make({ collection: "items", where: Predicate.eq("done", true) })
        );
        expect(result.some((r) => r.id === "i1")).toBe(true); // reflects the optimistic overlay, not the stale index
      })
  );

  it.effect("#133: a pending mutation on collection A doesn't disable collection B's index", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(noopHandler, "g");
      const engine = yield* ClientEngineModule.make({
        clientId: "c",
        clientGroupId: "g",
        mutators: setItemAndUser,
        indexes: { items: ["done"] },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      yield* seedEngine(engine, items(20));
      const doneQuery = () =>
        engine.query(Subset.make({ collection: "items", where: Predicate.eq("done", true) }));

      // Prime (and cache) the "items" index against the confirmed snapshot.
      yield* doneQuery();

      const evaluateSpy = vi.spyOn(CollectionIndex, "evaluate");
      evaluateSpy.mockClear();

      // A pending mutation on "users" — a different collection entirely —
      // must not disable "items"'s index: `evaluate` is still consulted.
      yield* engine.mutate("user/set", { id: "u1", name: "Ada" });
      const whileUserPending = yield* doneQuery();
      expect(evaluateSpy).toHaveBeenCalled();
      expect(whileUserPending.map((r) => r.id).toSorted()).toEqual(
        items(20)
          .filter((r) => r.done)
          .map((r) => r.id)
          .toSorted()
      );

      evaluateSpy.mockClear();

      // A pending mutation on "items" itself still falls back to a full
      // scan (the coarse pre-#133 behavior, unchanged for the touched
      // collection): `evaluate` is NOT consulted.
      yield* engine.mutate("item/set", { id: "i1", priority: 1, done: true });
      const whileItemsPending = yield* doneQuery();
      expect(evaluateSpy).not.toHaveBeenCalled();
      expect(whileItemsPending.some((r) => r.id === "i1")).toBe(true);

      evaluateSpy.mockRestore();
    })
  );

  it.effect("Put/Del/Clear via pull keep the index consistent", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const patches = yield* Ref.make<ReadonlyArray<PullResponse["patch"]>>([
        [
          {
            _tag: "Put",
            collection: "items",
            id: "a",
            version: 1,
            value: { id: "a", priority: 1 },
          },
        ],
        [{ _tag: "Del", collection: "items", id: "a" }],
        [
          {
            _tag: "Put",
            collection: "items",
            id: "b",
            version: 1,
            value: { id: "b", priority: 1 },
          },
        ],
        [{ _tag: "Clear" }],
      ]);
      const handler: ServerHandler = {
        handlePush: () => Effect.succeed({ lastMutationIds: {} }),
        handlePull: () =>
          Ref.modify(patches, (queue) => [queue[0] ?? [], queue.slice(1)]).pipe(
            Effect.map((patch) => ({ patch, cookie: "c", lastMutationIds: {} }))
          ),
        handleRead: () => Effect.succeed({ rows: [] }),
        pokes: () => noopHandler.pokes("g"),
      };
      const transport = yield* makeInMemory(handler, "g");
      const engine = yield* ClientEngineModule.make({
        clientId: "c",
        clientGroupId: "g",
        mutators: setItem,
        indexes: { items: ["priority"] },
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      const byPriority1 = () =>
        engine.query(Subset.make({ collection: "items", where: Predicate.eq("priority", 1) }));

      yield* engine.pull; // Put a
      expect((yield* byPriority1()).map((r) => r.id)).toEqual(["a"]);

      yield* engine.pull; // Del a
      expect((yield* byPriority1()).map((r) => r.id)).toEqual([]);

      yield* engine.pull; // Put b
      expect((yield* byPriority1()).map((r) => r.id)).toEqual(["b"]);

      yield* engine.pull; // Clear
      expect((yield* byPriority1()).map((r) => r.id)).toEqual([]);
    })
  );
});
