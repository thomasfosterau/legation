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
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import * as Hash from "../Hash.js";
import * as Incremental from "../Incremental.js";
import type { RowChange } from "../RowChange.js";
import * as Subset from "../Subset.js";
import { defined } from "./defined.js";

type Row<A> = Incremental.Row<A>;

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
  defined(values[Math.floor(rng() * values.length)]);

/** Two result maps are equal when they have the same ids and the same values. */
const sameResult = <A>(
  actual: ReadonlyMap<string, Row<A>>,
  expected: ReadonlyMap<string, Row<A>>
): boolean => {
  if (actual.size !== expected.size) return false;
  for (const [id, row] of expected) {
    const other = actual.get(id);
    if (other === undefined) return false;
    if (Hash.canonicalJson(other.value) !== Hash.canonicalJson(row.value)) return false;
  }
  return true;
};

const sameOrdered = <A>(actual: ReadonlyArray<Row<A>>, expected: ReadonlyArray<Row<A>>): boolean =>
  actual.length === expected.length &&
  actual.every(
    (row, i) =>
      row.id === defined(expected[i]).id &&
      Hash.canonicalJson(row.value) === Hash.canonicalJson(defined(expected[i]).value)
  );

/** The first prefix where incremental diverged from recompute, or `null`. */
type Divergence = string | null;

const divergence = (seed: number, step: number, actual: unknown, expected: unknown): string =>
  `seed ${seed} step ${step}: incremental diverged from recompute\n` +
  `  incremental: ${JSON.stringify(actual)}\n` +
  `  recompute:   ${JSON.stringify(expected)}`;

/** Mutate ground truth by a random put/del and return the resulting delta. */
const stepGround = <A>(
  rng: () => number,
  ground: Map<string, Row<A>>,
  ids: ReadonlyArray<string>,
  makeValue: (rng: () => number) => A,
  delChance: number
): Incremental.Delta<A> => {
  const id = pick(rng, ids);
  if (rng() < delChance) {
    const old = ground.get(id);
    if (old === undefined) return Incremental.emptyDelta;
    ground.delete(id);
    return { added: [], removed: [old] };
  }
  const next: Row<A> = { id, value: makeValue(rng) };
  const old = ground.get(id);
  if (old !== undefined && Hash.contentHash(old.value) === Hash.contentHash(next.value)) {
    return Incremental.emptyDelta;
  }
  ground.set(id, next);
  return old === undefined ? { added: [next], removed: [] } : { added: [next], removed: [old] };
};

// ─── Value generators / keys (module scope: shared, capture nothing) ─────────

const doubleN = (v: { readonly n: number }): { readonly double: number } => ({
  double: v.n * 2,
});
const teamKey = (v: { readonly team: string }): string => v.team;
const geFive = (v: { readonly n: number }): boolean => v.n >= 5;

/** Drive a single-input operator against its from-scratch reference. */
const runSingle = <A, B>(options: {
  readonly seeds: number;
  readonly steps: number;
  readonly ids: ReadonlyArray<string>;
  readonly makeValue: (rng: () => number) => A;
  readonly makeOperator: () => Incremental.Operator<A, B>;
  readonly fromScratch: (rows: ReadonlyArray<Row<A>>) => Map<string, Row<B>>;
  readonly delChance?: number;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const ground = new Map<string, Row<A>>();
    const operator = options.makeOperator();
    const result = new Map<string, Row<B>>();
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

const runJoin = <L, R, C>(options: {
  readonly seeds: number;
  readonly steps: number;
  readonly leftIds: ReadonlyArray<string>;
  readonly rightIds: ReadonlyArray<string>;
  readonly makeLeft: (rng: () => number) => L;
  readonly makeRight: (rng: () => number) => R;
  readonly makeOperator: () => Incremental.JoinOperator<L, R, C>;
  readonly fromScratch: (
    left: ReadonlyArray<Row<L>>,
    right: ReadonlyArray<Row<R>>
  ) => Map<string, Row<C>>;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const left = new Map<string, Row<L>>();
    const right = new Map<string, Row<R>>();
    const operator = options.makeOperator();
    const result = new Map<string, Row<C>>();
    for (let step = 0; step < options.steps; step++) {
      if (rng() < 0.5) {
        const delta = stepGround(rng, left, options.leftIds, options.makeLeft, 0.2);
        Incremental.applyDelta(result, operator.stepLeft(delta));
      } else {
        const delta = stepGround(rng, right, options.rightIds, options.makeRight, 0.2);
        Incremental.applyDelta(result, operator.stepRight(delta));
      }
      const expected = options.fromScratch([...left.values()], [...right.values()]);
      if (!sameResult(result, expected)) {
        return divergence(seed, step, [...result.values()], [...expected.values()]);
      }
    }
  }
  return null;
};

/** An ordered-window test row: a rank to sort by and an optional tie label. */
interface Ranked {
  readonly rank: number;
  readonly name?: string;
}

const runOrdered = (options: {
  readonly seeds: number;
  readonly steps: number;
  readonly ids: ReadonlyArray<string>;
  readonly makeValue: (rng: () => number) => Ranked;
  readonly orderBy: ReadonlyArray<Subset.OrderBy>;
  readonly limit?: number;
}): Divergence => {
  for (let seed = 1; seed <= options.seeds; seed++) {
    const rng = mulberry32(seed);
    const ground = new Map<string, Row<Ranked>>();
    const window = Incremental.makeOrderedWindow<Ranked>(options.orderBy, options.limit);
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
interface Right {
  readonly k: string;
  readonly rlbl: number;
}
const makeRight = (rng: () => number): Right => ({
  k: pick(rng, ["k0", "k1", "k2"]),
  rlbl: Math.floor(rng() * 100),
});
type Left = ReturnType<typeof makeLeft>;
const leftKey = (v: Left) => v.fk;
const rightKey = (v: Right): string => v.k;
const innerJoin = { leftKey, rightKey, kind: "inner" } as const;
const leftJoin = { leftKey, rightKey, kind: "left" } as const;
const labelled = {
  leftKey,
  rightKey,
  kind: "left",
  combine: (left: Left, right: Option.Option<Right>): string =>
    `${left.lbl}:${Option.match(right, { onNone: () => "-", onSome: (r) => `${r.rlbl}` })}`,
} as const;

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
        makeOperator: () => Incremental.makeJoin(innerJoin),
        fromScratch: (left, right) => Incremental.joinFromScratch(left, right, innerJoin),
      })
    ).toBeNull();
  });

  it("left join keeps unmatched left rows with an Option.none() right", () => {
    expect(
      runJoin({
        seeds: 16,
        steps: 300,
        leftIds: ["l0", "l1", "l2", "l3", "l4"],
        rightIds: ["r0", "r1", "r2", "r3", "r4", "r5"],
        makeLeft,
        makeRight,
        makeOperator: () => Incremental.makeJoin(leftJoin),
        fromScratch: (left, right) => Incremental.joinFromScratch(left, right, leftJoin),
      })
    ).toBeNull();
  });

  it("left join with a combine shapes each joined value", () => {
    expect(
      runJoin({
        seeds: 16,
        steps: 300,
        leftIds: ["l0", "l1", "l2", "l3", "l4"],
        rightIds: ["r0", "r1", "r2", "r3", "r4", "r5"],
        makeLeft,
        makeRight,
        makeOperator: () => Incremental.makeJoin(labelled),
        fromScratch: (left, right) => Incremental.joinFromScratch(left, right, labelled),
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
const changeBatchOf = <A>(delta: Incremental.Delta<A>): ReadonlyArray<RowChange<Row<A>>> => {
  if (
    delta.added.length === 1 &&
    delta.removed.length === 1 &&
    defined(delta.added[0]).id === defined(delta.removed[0]).id
  ) {
    return [{ _tag: "update", row: defined(delta.added[0]), previous: defined(delta.removed[0]) }];
  }
  const changes: Array<RowChange<Row<A>>> = [];
  Arr.forEach(delta.added, (row) => {
    changes.push({ _tag: "enter", row });
  });
  Arr.forEach(delta.removed, (row) => {
    changes.push({ _tag: "exit", id: row.id, previous: row });
  });
  return changes;
};

/** `null` if every step of one seed matched, else a description of the first divergence. */
const runDeltaFromChangesSession = (seed: number, steps: number): string | null => {
  const rng = mulberry32(seed);
  const ground = new Map<string, Row<{ readonly n: number }>>();
  const known = new Map<string, Row<{ readonly n: number }>>();
  const ids = ["a", "b", "c", "d", "e", "f"];
  const makeValue = (r: () => number) => ({ n: Math.floor(r() * 10) });
  for (let step = 0; step < steps; step++) {
    // Occasionally exercise `reset` (a Rebuild/gap-collapse batch) instead of
    // a single-row delta.
    if (rng() < 0.05) {
      const knownSizeBefore = known.size;
      const batch: ReadonlyArray<RowChange<Row<{ readonly n: number }>>> = [
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
      const ground = new Map<string, Row<{ readonly n: number }>>();
      const known = new Map<string, Row<{ readonly n: number }>>();
      const operator = Incremental.makeFilter(geFive);
      const result = new Map<string, Row<{ readonly n: number }>>();
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
