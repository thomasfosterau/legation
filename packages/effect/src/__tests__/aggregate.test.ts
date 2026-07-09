/**
 * Aggregate: pure evaluation (count/sum/min/max/avg incl. empty and
 * non-numeric handling), schema round-trips, grouped evaluation, and the live
 * `observeAggregate` surface over a MemoryBackend-synced collection — which
 * must re-emit on a relevant write and, crucially, stay silent when a write
 * leaves the aggregate value unchanged.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import * as Aggregate from "../Aggregate.js";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const rowsOf = (...values: ReadonlyArray<unknown>) =>
  values.map((value, i) => ({ id: `${i}`, value }));

describe("Aggregate.compute", () => {
  it("Count counts rows regardless of field content", () => {
    expect(Aggregate.compute(Aggregate.count, rowsOf({ n: 1 }, {}, 3))).toBe(3);
    expect(Aggregate.compute(Aggregate.count, [])).toBe(0);
  });

  it("Sum folds numeric fields; empty sum is 0; non-numeric are skipped", () => {
    const rows = rowsOf({ n: 2 }, { n: 3 }, { n: "x" }, { n: null }, {});
    expect(Aggregate.compute(Aggregate.sum("n"), rows)).toBe(5);
    expect(Aggregate.compute(Aggregate.sum("n"), [])).toBe(0);
    expect(Aggregate.compute(Aggregate.sum("n"), rowsOf({ n: "a" }))).toBe(0);
  });

  it("Avg is the mean of numeric values; empty/all-non-numeric is undefined", () => {
    const rows = rowsOf({ n: 2 }, { n: 4 }, { n: "skip" });
    expect(Aggregate.compute(Aggregate.avg("n"), rows)).toBe(3);
    expect(Aggregate.compute(Aggregate.avg("n"), [])).toBeUndefined();
    expect(Aggregate.compute(Aggregate.avg("n"), rowsOf({ n: "a" }))).toBeUndefined();
  });

  it("Min/Max pick the least/greatest numeric value; empty is undefined", () => {
    const rows = rowsOf({ n: 5 }, { n: -2 }, { n: 3 }, { n: "x" });
    expect(Aggregate.compute(Aggregate.min("n"), rows)).toBe(-2);
    expect(Aggregate.compute(Aggregate.max("n"), rows)).toBe(5);
    expect(Aggregate.compute(Aggregate.min("n"), [])).toBeUndefined();
    expect(Aggregate.compute(Aggregate.max("n"), rowsOf({ n: false }))).toBeUndefined();
  });
});

describe("Aggregate.computeGrouped", () => {
  it("keys per-group values by String(row.value[groupBy])", () => {
    const rows = rowsOf(
      { team: "a", n: 1 },
      { team: "a", n: 3 },
      { team: "b", n: 10 },
      { team: 2, n: 4 }
    );
    expect(Aggregate.computeGrouped(Aggregate.sum("n"), rows, "team")).toEqual({
      a: 4,
      b: 10,
      "2": 4,
    });
    expect(Aggregate.computeGrouped(Aggregate.count, rows, "team")).toEqual({
      a: 2,
      b: 1,
      "2": 1,
    });
  });
});

describe("AggregateSchema", () => {
  const roundTrip = (agg: Aggregate.Aggregate) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Aggregate.AggregateSchema)(agg);
      const decoded = yield* Schema.decodeUnknownEffect(Aggregate.AggregateSchema)(
        JSON.parse(JSON.stringify(encoded))
      );
      expect(decoded).toEqual(agg);
    });

  it.effect("round-trips Count", () => roundTrip(Aggregate.count));
  it.effect("round-trips Sum", () => roundTrip(Aggregate.sum("amount")));
  it.effect("round-trips Min", () => roundTrip(Aggregate.min("amount")));
  it.effect("round-trips Max", () => roundTrip(Aggregate.max("amount")));
  it.effect("round-trips Avg", () => roundTrip(Aggregate.avg("amount")));
});

// ─── Live observeAggregate over a synced collection ──────────────────────────

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const put =
  (collection: string): MemoryBackend.BackendHandler =>
  (args, writer) =>
    Effect.asVoid(writer.put(collection, (args as { id: string }).id, args));

const handlers: Record<string, MemoryBackend.BackendHandler> = { "todo/set": put("todos") };
const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (a, w) => w.put("todos", (a as Todo).id, a),
  },
]);

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (handler: ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, group);
    return yield* ClientEngineModule.make({ clientId: group, clientGroupId: group, mutators }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const allTodos = Subset.make({ collection: "todos" });
const activeTodos = Subset.make({ collection: "todos", where: Predicate.eq("done", false) });
const settle = Effect.sleep(Duration.millis(50));

describe("observeAggregate over a synced collection", () => {
  it.live("re-emits on a relevant write and stays silent on a no-op write", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const writer = yield* makeClient(handler, "writer");
      const reader = yield* makeClient(handler, "reader");

      yield* writer.mutate("todo/set", { id: "t1", title: "one", done: false });
      yield* writer.mutate("todo/set", { id: "t2", title: "two", done: false });
      yield* writer.push;
      yield* reader.subscribe(allTodos);
      yield* reader.pull;

      const emissions = yield* Ref.make<Array<Aggregate.AggregateValue>>([]);
      yield* Effect.forkScoped(
        Stream.runForEach(reader.observeAggregate(activeTodos, Aggregate.count), (value) =>
          Ref.update(emissions, (acc) => [...acc, value])
        )
      );
      yield* settle;
      expect(yield* Ref.get(emissions)).toEqual([2]); // initial: two active todos

      // A no-op for the aggregate: edit t1's title, leave it active. The rows
      // change, but the active count stays 2 → no re-emission.
      yield* writer.mutate("todo/set", { id: "t1", title: "one (edited)", done: false });
      yield* writer.push;
      yield* reader.pull;
      yield* settle;
      expect(yield* Ref.get(emissions)).toEqual([2]);

      // A relevant write: a new active todo bumps the count to 3.
      yield* writer.mutate("todo/set", { id: "t3", title: "three", done: false });
      yield* writer.push;
      yield* reader.pull;
      yield* settle;
      expect(yield* Ref.get(emissions)).toEqual([2, 3]);

      // Completing t1 removes it from the active subset → count back to 2.
      yield* writer.mutate("todo/set", { id: "t1", title: "one (edited)", done: true });
      yield* writer.push;
      yield* reader.pull;
      yield* settle;
      expect(yield* Ref.get(emissions)).toEqual([2, 3, 2]);
    }).pipe(Effect.scoped)
  );

  it.live("observeAggregateGrouped produces per-group values", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const writer = yield* makeClient(handler, "gwriter");
      const reader = yield* makeClient(handler, "greader");

      yield* writer.mutate("todo/set", { id: "t1", title: "a", done: false });
      yield* writer.mutate("todo/set", { id: "t2", title: "b", done: true });
      yield* writer.mutate("todo/set", { id: "t3", title: "c", done: true });
      yield* writer.push;
      yield* reader.subscribe(allTodos);
      yield* reader.pull;

      const latest = yield* Ref.make<Record<string, Aggregate.AggregateValue>>({});
      yield* Effect.forkScoped(
        Stream.runForEach(
          reader.observeAggregateGrouped(allTodos, Aggregate.count, "done"),
          (value) => Ref.set(latest, value)
        )
      );
      yield* settle;
      expect(yield* Ref.get(latest)).toEqual({ false: 1, true: 2 });
    }).pipe(Effect.scoped)
  );
});

// ─── Incremental maintenance (#110) ───────────────────────────────────────────
//
// Property test: incrementally-maintained state must equal `compute` /
// `computeGrouped` run from scratch, after every prefix of a randomized
// put/del sequence — including group-key moves, `null` fields, and
// type-mismatched (string vs. number) group keys. A small seeded PRNG keeps
// failures reproducible without adding a property-testing dependency.

const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const IDS = Array.from({ length: 8 }, (_, i) => `r${i}`);
// Mixes number and string group keys on purpose (type-mismatched fields).
const TEAMS: ReadonlyArray<unknown> = ["a", "b", 1, 2, undefined];

const randomRowValue = (rand: () => number): unknown => {
  const r = rand();
  const score =
    r < 0.55
      ? Math.floor(rand() * 21) - 5 // includes negatives/zero, filtered by `where`
      : r < 0.7
        ? null
        : r < 0.85
          ? "not-a-number"
          : undefined;
  return { score, team: TEAMS[Math.floor(rand() * TEAMS.length)] };
};

interface RandomOp {
  readonly _tag: "Put" | "Del";
  readonly id: string;
  readonly value?: unknown;
}

const randomOps = (rand: () => number, n: number): ReadonlyArray<RandomOp> =>
  Array.from({ length: n }, () => {
    const id = IDS[Math.floor(rand() * IDS.length)]!;
    return rand() < 0.25
      ? { _tag: "Del" as const, id }
      : { _tag: "Put" as const, id, value: randomRowValue(rand) };
  });

describe("Aggregate incremental state (#110)", () => {
  const where = Predicate.gt("score", 0);
  const groupBy = "team";
  const aggs: ReadonlyArray<Aggregate.Aggregate> = [
    Aggregate.count,
    Aggregate.sum("score"),
    Aggregate.avg("score"),
    Aggregate.min("score"),
    Aggregate.max("score"),
  ];

  const matchingRows = (
    truth: ReadonlyMap<string, unknown>
  ): ReadonlyArray<{ readonly id: string; readonly value: unknown }> =>
    [...truth.entries()]
      .filter(([, value]) => Predicate.test(where, value))
      .map(([id, value]) => ({ id, value }));

  it("matches compute/computeGrouped from scratch after every prefix of a randomized delta sequence", () => {
    for (let seed = 0; seed < 40; seed++) {
      const rand = mulberry32(seed);
      const ops = randomOps(rand, 60);
      const truth = new Map<string, unknown>();
      const states = new Map<Aggregate.Aggregate, Aggregate.State>(
        aggs.map((agg) => [agg, Aggregate.initState(agg, [])])
      );
      const groupedStates = new Map<Aggregate.Aggregate, Aggregate.GroupedState>(
        aggs.map((agg) => [agg, Aggregate.initGroupedState(agg, [], groupBy)])
      );

      for (const op of ops) {
        if (op._tag === "Del") truth.delete(op.id);
        else truth.set(op.id, op.value);

        for (const agg of aggs) {
          states.set(
            agg,
            op._tag === "Del"
              ? Aggregate.applyDel(states.get(agg)!, agg, op.id)
              : Aggregate.applyPut(states.get(agg)!, agg, where, op.id, op.value)
          );
          groupedStates.set(
            agg,
            op._tag === "Del"
              ? Aggregate.applyGroupedDel(groupedStates.get(agg)!, agg, op.id)
              : Aggregate.applyGroupedPut(
                  groupedStates.get(agg)!,
                  agg,
                  where,
                  groupBy,
                  op.id,
                  op.value
                )
          );
        }

        const rows = matchingRows(truth);
        for (const agg of aggs) {
          expect(Aggregate.stateValue(states.get(agg)!)).toEqual(Aggregate.compute(agg, rows));
          expect(Aggregate.groupedStateValue(groupedStates.get(agg)!)).toEqual(
            Aggregate.computeGrouped(agg, rows, groupBy)
          );
        }
      }
    }
  });
});
