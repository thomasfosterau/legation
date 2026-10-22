/**
 * Property test (issue #114 acceptance criteria): each derived combinator's
 * incrementally-maintained result must equal a naive from-scratch recompute —
 * after *every prefix* of a randomized delta sequence, not just the final
 * state, so a bug that self-corrects after enough churn can't hide. This drives
 * the {@link Incremental} operator core directly (no Effect/stream involved —
 * the operators are pure), the same shape as `LiveView`/`Related`'s property
 * tests.
 *
 * Deltas are generated exactly as the streaming layer produces them: a ground-
 * truth `Map<id, Row>` is mutated by a random put/del and the change is the
 * `added`/`removed` pair — a put over an existing id is an update (remove old +
 * add new), a put of a new id an add, a del a remove. Each runner returns the
 * first divergence (or `null`); the `it` asserts on that, so the failing seed,
 * step, and values print. Uses a deterministic mulberry32 PRNG so a failure is
 * reproducible from its printed seed.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Hash from "../Hash.js";
import * as Incremental from "../Incremental.js";
import type { RowChange } from "../RowChange.js";
import * as Subset from "../Subset.js";

type Row = Incremental.Row;

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <A>(rng: () => number, values: ReadonlyArray<A>): A =>
  values[Math.floor(rng() * values.length)]!;

/** Two result maps are equal when they have the same ids and the same values. */
const sameResult = (
  actual: ReadonlyMap<string, Row>,
  expected: ReadonlyMap<string, Row>
): boolean => {
  if (actual.size !== expected.size) return false;
  for (const [id, row] of expected) {
    const other = actual.get(id);
    if (other === undefined) return false;
    if (Hash.canonicalJson(other.value) !== Hash.canonicalJson(row.value)) return false;
  }
  return true;
};

const sameOrdered = (actual: ReadonlyArray<Row>, expected: ReadonlyArray<Row>): boolean =>
  actual.length === expected.length &&
  actual.every(
    (row, i) =>
      row.id === expected[i]!.id &&
      Hash.canonicalJson(row.value) === Hash.canonicalJson(expected[i]!.value)
  );

/** The first prefix where incremental diverged from recompute, or `null`. */
type Divergence = string | null;

const divergence = (seed: number, step: number, actual: unknown, expected: unknown): string =>
  `seed ${seed} step ${step}: incremental diverged from recompute\n` +
  `  incremental: ${JSON.stringify(actual)}\n` +
  `  recompute:   ${JSON.stringify(expected)}`;

/** Mutate ground truth by a random put/del and return the resulting delta. */
const stepGround = <V>(
  rng: () => number,
  ground: Map<string, Row>,
  ids: ReadonlyArray<string>,
  makeValue: (rng: () => number) => V,
  delChance: number
): Incremental.Delta => {
  const id = pick(rng, ids);
  if (rng() < delChance) {
    const old = ground.get(id);
    if (old === undefined) return Incremental.emptyDelta;
    ground.delete(id);
    return { added: [], removed: [old] };
  }
  const next: Row = { id, value: makeValue(rng) };
  const old = ground.get(id);
  if (old !== undefined && Hash.contentHash(old.value) === Hash.contentHash(next.value)) {
    return Incremental.emptyDelta;
  }
  ground.set(id, next);
  return old === undefined ? { added: [next], removed: [] } : { added: [next], removed: [old] };
};

// ─── Value generators / keys (module scope: shared, capture nothing) ─────────

const doubleN = (v: unknown): { readonly double: number } => ({
  double: (v as { n: number }).n * 2,
});
const teamKey = (v: unknown): string => (v as { team: string }).team;
const geFive = (v: unknown): boolean => (v as { n: number }).n >= 5;

/** Drive a single-input operator against its from-scratch reference. */
const runSingle = <V>(options: {
  readonly seeds: number;
  readonly steps: number;
  readonly ids: ReadonlyArray<string>;
  readonly makeValue: (rng: () => number) => V;
  readonly makeOperator: () => Incremental.Operator;
  readonly fromScratch: (rows: ReadonlyArray<Row>) => Map<string, Row>;
  readonly delChance?: number;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const ground = new Map<string, Row>();
    const operator = options.makeOperator();
    const result = new Map<string, Row>();
    for (let step = 0; step < options.steps; step++) {
      const delta = stepGround(
        rng,
        ground,
        options.ids,
        options.makeValue,
        options.delChance ?? 0.2
      );
      Incremental.applyDelta(result, operator.step(delta));
      const expected = options.fromScratch([...ground.values()]);
      if (!sameResult(result, expected)) {
        return divergence(seed, step, [...result.values()], [...expected.values()]);
      }
    }
  }
  return null;
};

const runJoin = <L, R>(options: {
  readonly seeds: number;
  readonly steps: number;
  readonly leftIds: ReadonlyArray<string>;
  readonly rightIds: ReadonlyArray<string>;
  readonly makeLeft: (rng: () => number) => L;
  readonly makeRight: (rng: () => number) => R;
  readonly joinOptions: Incremental.JoinOptions;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const left = new Map<string, Row>();
    const right = new Map<string, Row>();
    const operator = Incremental.makeJoin(options.joinOptions);
    const result = new Map<string, Row>();
    for (let step = 0; step < options.steps; step++) {
      if (rng() < 0.5) {
        const delta = stepGround(rng, left, options.leftIds, options.makeLeft, 0.2);
        Incremental.applyDelta(result, operator.stepLeft(delta));
      } else {
        const delta = stepGround(rng, right, options.rightIds, options.makeRight, 0.2);
        Incremental.applyDelta(result, operator.stepRight(delta));
      }
      const expected = Incremental.joinFromScratch(
        [...left.values()],
        [...right.values()],
        options.joinOptions
      );
      if (!sameResult(result, expected)) {
        return divergence(seed, step, [...result.values()], [...expected.values()]);
      }
    }
  }
  return null;
};

const runOrdered = <V>(options: {
  readonly seeds: number;
  readonly steps: number;
  readonly ids: ReadonlyArray<string>;
  readonly makeValue: (rng: () => number) => V;
  readonly orderBy: ReadonlyArray<Subset.OrderBy>;
  readonly limit?: number;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const ground = new Map<string, Row>();
    const window = Incremental.makeOrderedWindow(options.orderBy, options.limit);
    for (let step = 0; step < options.steps; step++) {
      const delta = stepGround(rng, ground, options.ids, options.makeValue, 0.2);
      const paged = window.step(delta);
      const expected = Incremental.orderedWindowFromScratch(
        [...ground.values()],
        options.orderBy,
        options.limit
      );
      if (!sameOrdered(paged, expected)) return divergence(seed, step, paged, expected);
    }
  }
  return null;
};

describe("Incremental — delta-in/delta-out equivalence with naive recompute", () => {
  it("filter (arbitrary predicate) — rows crossing in and out on update", () => {
    expect(
      runSingle({
        seeds: 16,
        steps: 200,
        ids: ["a", "b", "c", "d", "e", "f"],
        makeValue: (rng) => ({ n: Math.floor(rng() * 10), tag: pick(rng, ["x", "y"]) }),
        makeOperator: () => Incremental.makeFilter(geFive),
        fromScratch: (rows) => Incremental.filterFromScratch(rows, geFive),
      })
    ).toBeNull();
  });

  it("map/select — projection preserves identity", () => {
    expect(
      runSingle({
        seeds: 12,
        steps: 150,
        ids: ["a", "b", "c", "d", "e"],
        makeValue: (rng) => ({ n: Math.floor(rng() * 10) }),
        makeOperator: () => Incremental.makeMap(doubleN),
        fromScratch: (rows) => Incremental.mapFromScratch(rows, doubleN),
      })
    ).toBeNull();
  });

  it("distinct — multiplicity survives removing one of several duplicates", () => {
    // A small value domain over many ids forces genuine duplicates.
    expect(
      runSingle({
        seeds: 20,
        steps: 250,
        ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
        makeValue: (rng) => ({ c: pick(rng, ["p", "q", "r"]) }),
        makeOperator: () => Incremental.makeDistinct(),
        fromScratch: (rows) => Incremental.distinctFromScratch(rows),
      })
    ).toBeNull();
  });

  it("groupBy — returns grouped rows, touching only affected groups", () => {
    expect(
      runSingle({
        seeds: 16,
        steps: 250,
        ids: ["a", "b", "c", "d", "e", "f", "g"],
        makeValue: (rng) => ({ team: pick(rng, ["t0", "t1", "t2"]), n: Math.floor(rng() * 100) }),
        makeOperator: () => Incremental.makeGroupBy(teamKey),
        fromScratch: (rows) => Incremental.groupByFromScratch(rows, teamKey),
      })
    ).toBeNull();
  });
});

// ─── Join (two inputs) ───────────────────────────────────────────────────────

// fk spans matching keys, a dangling key, and null (never joins) so both
// match-multiplicity and no-match paths are exercised.
const makeLeft = (rng: () => number) => ({
  fk: pick(rng, ["k0", "k1", "k2", "kmiss", null]),
  lbl: Math.floor(rng() * 100),
});
const makeRight = (rng: () => number) => ({
  k: pick(rng, ["k0", "k1", "k2"]),
  rlbl: Math.floor(rng() * 100),
});
const leftKey = (v: unknown): string | null => (v as { fk: string | null }).fk;
const rightKey = (v: unknown): string => (v as { k: string }).k;

describe("Incremental.join — arbitrary key equality", () => {
  it("inner join matches recompute after every prefix", () => {
    expect(
      runJoin({
        seeds: 16,
        steps: 300,
        leftIds: ["l0", "l1", "l2", "l3", "l4"],
        rightIds: ["r0", "r1", "r2", "r3", "r4", "r5"],
        makeLeft,
        makeRight,
        joinOptions: { leftKey, rightKey, kind: "inner" },
      })
    ).toBeNull();
  });

  it("left join keeps unmatched left rows with a null right", () => {
    expect(
      runJoin({
        seeds: 16,
        steps: 300,
        leftIds: ["l0", "l1", "l2", "l3", "l4"],
        rightIds: ["r0", "r1", "r2", "r3", "r4", "r5"],
        makeLeft,
        makeRight,
        joinOptions: { leftKey, rightKey, kind: "left" },
      })
    ).toBeNull();
  });
});

// ─── Ordered window ──────────────────────────────────────────────────────────

// ─── deltaFromChanges (#133 item 1: observeChanges as combinator input) ─────
//
// `stepGround` above already synthesizes exactly the delta a real `LiveView`
// put/del would produce (at most one row touched per step); converting it to
// the equivalent `RowChange` batch and recovering a delta via
// `deltaFromChanges` must reproduce the *same* delta `Incremental.diff` would
// have recovered by re-diffing two pages — proving `Derive.observed`'s
// change-feed path is behaviorally identical to the page-diff fallback it
// replaces, not just "also plausible."

/** The `RowChange` batch a real `observeChanges` stream would emit for one
 * `stepGround` delta (which touches at most one row per step). */
const changeBatchOf = (delta: Incremental.Delta): ReadonlyArray<RowChange<Row>> => {
  if (
    delta.added.length === 1 &&
    delta.removed.length === 1 &&
    delta.added[0]!.id === delta.removed[0]!.id
  ) {
    return [{ _tag: "update", row: delta.added[0]!, previous: delta.removed[0]! }];
  }
  const changes: Array<RowChange<Row>> = [];
  for (const row of delta.added) changes.push({ _tag: "enter", row });
  for (const row of delta.removed) changes.push({ _tag: "exit", id: row.id, previous: row });
  return changes;
};

/** `null` if every step of one seed matched, else a description of the first divergence. */
const runDeltaFromChangesSession = (seed: number, steps: number): string | null => {
  const rng = mulberry32(seed);
  const ground = new Map<string, Row>();
  const known = new Map<string, Row>();
  const ids = ["a", "b", "c", "d", "e", "f"];
  const makeValue = (r: () => number) => ({ n: Math.floor(r() * 10) });
  for (let step = 0; step < steps; step++) {
    // Occasionally exercise `reset` (a Rebuild/gap-collapse batch) instead of
    // a single-row delta.
    if (rng() < 0.05) {
      const knownSizeBefore = known.size;
      const batch: ReadonlyArray<RowChange<Row>> = [
        { _tag: "reset" },
        ...[...ground.values()].map((row) => ({ _tag: "enter" as const, row })),
      ];
      const recovered = Incremental.deltaFromChanges(known, batch);
      // A reset removes everything `known` held (regardless of whether it
      // matches the fresh ground truth) and adds every row `ground` holds
      // now — the same "clear then fresh enters" semantics `RowChange.reset`
      // documents.
      if (recovered.removed.length !== knownSizeBefore) {
        return `seed ${seed} step ${step}: reset removed ${recovered.removed.length}, expected ${knownSizeBefore}`;
      }
      const recoveredIds = recovered.added.map((r) => r.id).toSorted();
      const groundIds = [...ground.keys()].toSorted();
      if (JSON.stringify(recoveredIds) !== JSON.stringify(groundIds)) {
        return `seed ${seed} step ${step}: reset's added ids didn't match ground truth`;
      }
      if (known.size !== ground.size) {
        return `seed ${seed} step ${step}: known.size ${known.size} !== ground.size ${ground.size}`;
      }
      continue;
    }
    const delta = stepGround(rng, ground, ids, makeValue, 0.2);
    const batch = changeBatchOf(delta);
    const recovered = Incremental.deltaFromChanges(known, batch);
    if (JSON.stringify(recovered) !== JSON.stringify(delta)) {
      return `seed ${seed} step ${step}: recovered ${JSON.stringify(recovered)} !== expected ${JSON.stringify(delta)}`;
    }
  }
  return null;
};

describe("Incremental.deltaFromChanges — equivalent to diffing pages, not just plausible", () => {
  it("recovers the exact delta a page-diff would have, every step, including resets", () => {
    for (let seed = 1; seed <= 20; seed++) {
      expect(runDeltaFromChangesSession(seed, 200)).toBeNull();
    }
  });

  it("driving an operator via deltaFromChanges matches the from-scratch recompute", () => {
    for (let seed = 1; seed <= 16; seed++) {
      const rng = mulberry32(seed);
      const ground = new Map<string, Row>();
      const known = new Map<string, Row>();
      const operator = Incremental.makeFilter(geFive);
      const result = new Map<string, Row>();
      const ids = ["a", "b", "c", "d", "e", "f"];
      const makeValue = (r: () => number) => ({ n: Math.floor(r() * 10) });
      for (let step = 0; step < 150; step++) {
        const delta = stepGround(rng, ground, ids, makeValue, 0.2);
        const batch = changeBatchOf(delta);
        const recovered = Incremental.deltaFromChanges(known, batch);
        Incremental.applyDelta(result, operator.step(recovered));
        const expected = Incremental.filterFromScratch([...ground.values()], geFive);
        expect(sameResult(result, expected)).toBe(true);
      }
    }
  });
});

describe("Incremental.orderedWindow — orderBy + limit over derived rows", () => {
  it("limit narrow enough to force push-out/pull-in across the boundary", () => {
    expect(
      runOrdered({
        seeds: 16,
        steps: 250,
        ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
        makeValue: (rng) => ({ rank: Math.floor(rng() * 6), name: pick(rng, ["m", "n", "o"]) }),
        orderBy: [{ field: "rank", direction: "asc" }],
        limit: 3,
      })
    ).toBeNull();
  });

  it("no orderBy still yields a stable (id-ascending) order, no limit", () => {
    expect(
      runOrdered({
        seeds: 8,
        steps: 150,
        ids: ["a", "b", "c", "d", "e"],
        makeValue: (rng) => ({ rank: Math.floor(rng() * 6) }),
        orderBy: [],
      })
    ).toBeNull();
  });
});
