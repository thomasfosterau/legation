/**
 * Aggregate: pure evaluation (count/sum/min/max/avg incl. empty and
 * non-numeric handling), schema round-trips, grouped evaluation, and the live
 * `observeAggregate` surface over a MemoryBackend-synced collection — which
 * must re-emit on a relevant write and, crucially, stay silent when a write
 * leaves the aggregate value unchanged.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
import { defined } from "./defined.js";

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

  it.live(
    "observeAggregateGrouped folds later writes in incrementally, including a group move",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const client = yield* makeClient(handler, "gincremental");

        yield* client.mutate("todo/set", { id: "t1", title: "a", done: false });
        yield* client.mutate("todo/set", { id: "t2", title: "b", done: true });
        yield* client.subscribe(allTodos);

        const latest = yield* Ref.make<Record<string, Aggregate.AggregateValue>>({});
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observeAggregateGrouped(allTodos, Aggregate.count, "done"),
            (value) => Ref.set(latest, value)
          )
        );
        yield* settle;
        expect(yield* Ref.get(latest)).toEqual({ false: 1, true: 1 });

        // A new row joins a group, then an existing row moves between groups:
        // each arrives as a row-level delta the grouped state folds in place.
        yield* client.mutate("todo/set", { id: "t3", title: "c", done: true });
        yield* settle;
        expect(yield* Ref.get(latest)).toEqual({ false: 1, true: 2 });

        yield* client.mutate("todo/set", { id: "t2", title: "b", done: false });
        yield* settle;
        expect(yield* Ref.get(latest)).toEqual({ false: 2, true: 1 });
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
const TEAMS: ReadonlyArray<string | number | undefined> = ["a", "b", 1, 2, undefined];

/** A generated row: `score` is sometimes non-numeric and `team` mixes key types. */
interface RandomRowValue {
  readonly score: number | string | null | undefined;
  readonly team: string | number | undefined;
}

const randomRowValue = (rand: () => number): RandomRowValue => {
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
    const id = defined(IDS[Math.floor(rand() * IDS.length)]);
    return rand() < 0.25
      ? { _tag: "Del" as const, id }
      : { _tag: "Put" as const, id, value: randomRowValue(rand) };
  });

const INCREMENTAL_WHERE = Predicate.gt("score", 0);
const INCREMENTAL_GROUP_BY = "team";
const INCREMENTAL_AGGS: ReadonlyArray<Aggregate.Aggregate> = [
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
    .filter(([, value]) => Predicate.test(INCREMENTAL_WHERE, value))
    .map(([id, value]) => ({ id, value }));

/** Fold one op into `agg`'s incremental state (mutated in place, per `Aggregate.applyPut`/`applyDel`). */
const applyOpToState = (
  state: Aggregate.State,
  agg: Aggregate.Aggregate,
  op: RandomOp
): Aggregate.State =>
  op._tag === "Del"
    ? Aggregate.applyDel(state, agg, op.id)
    : Aggregate.applyPut(state, agg, INCREMENTAL_WHERE, op.id, op.value);

/** Fold one op into `agg`'s incremental grouped state (mutated in place). */
const applyOpToGroupedState = (
  state: Aggregate.GroupedState,
  agg: Aggregate.Aggregate,
  op: RandomOp
): Aggregate.GroupedState =>
  op._tag === "Del"
    ? Aggregate.applyGroupedDel(state, agg, op.id)
    : Aggregate.applyGroupedPut(
        state,
        agg,
        INCREMENTAL_WHERE,
        INCREMENTAL_GROUP_BY,
        op.id,
        op.value
      );

/** Assert `agg`'s incrementally-maintained value(s) match a from-scratch fold over `rows`. */
const expectAggMatches = (
  agg: Aggregate.Aggregate,
  state: Aggregate.State,
  groupedState: Aggregate.GroupedState,
  rows: ReadonlyArray<{ readonly id: string; readonly value: unknown }>
): void => {
  expect(Aggregate.stateValue(state)).toEqual(Aggregate.compute(agg, rows));
  expect(Aggregate.groupedStateValue(groupedState)).toEqual(
    Aggregate.computeGrouped(agg, rows, INCREMENTAL_GROUP_BY)
  );
};

/**
 * Run one seed's randomized delta sequence, checking after every prefix that
 * every aggregate's incremental state (ungrouped and grouped) matches a
 * from-scratch fold over the rows currently matching `INCREMENTAL_WHERE`.
 */
const checkIncrementalSeed = (seed: number): void => {
  const ops = randomOps(mulberry32(seed), 60);
  const truth = new Map<string, unknown>();
  const states = new Map(INCREMENTAL_AGGS.map((agg) => [agg, Aggregate.initState(agg, [])]));
  const groupedStates = new Map(
    INCREMENTAL_AGGS.map((agg) => [agg, Aggregate.initGroupedState(agg, [], INCREMENTAL_GROUP_BY)])
  );

  for (const op of ops) {
    if (op._tag === "Del") truth.delete(op.id);
    else truth.set(op.id, op.value);

    for (const agg of INCREMENTAL_AGGS) {
      states.set(agg, applyOpToState(defined(states.get(agg)), agg, op));
      groupedStates.set(agg, applyOpToGroupedState(defined(groupedStates.get(agg)), agg, op));
    }

    const rows = matchingRows(truth);
    for (const agg of INCREMENTAL_AGGS) {
      expectAggMatches(agg, defined(states.get(agg)), defined(groupedStates.get(agg)), rows);
    }
  }
};

describe("Aggregate incremental state (#110)", () => {
  it("matches compute/computeGrouped from scratch after every prefix of a randomized delta sequence", () => {
    for (let seed = 0; seed < 40; seed++) checkIncrementalSeed(seed);
  });
});
