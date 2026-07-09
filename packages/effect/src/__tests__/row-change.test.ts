/**
 * RowChange (#115): property test that folding the change feed reproduces
 * `observe()`'s pages exactly. `LiveView.put`/`del` already decide predicate
 * and window membership per row (`live-view.test.ts` covers that in
 * isolation); this drives long randomized sequences of upserts/deletes
 * (plus periodic Rebuilds, mirroring the engine's conservative fallback) and
 * checks that folding `RowChange.diff`/`reset` batches into a plain map
 * reproduces `LiveView.result` after every single step — not just at the end
 * — across several subset shapes (predicate-only, ordered+limited,
 * unordered).
 *
 * No `fast-check`/`Schema.Arbitrary` dependency exists in this codebase yet
 * (see CONTEXT.md's testing conventions); this follows the repo's existing
 * convention of a tiny seeded PRNG instead, so a failure prints a
 * reproducible seed.
 */
import { describe, expect, it } from "vitest";
import * as LiveView from "../LiveView.js";
import * as Predicate from "../Predicate.js";
import * as RowChange from "../RowChange.js";
import * as Subset from "../Subset.js";

/** mulberry32: tiny deterministic PRNG so a failing seed is reproducible. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Item {
  readonly rank: number;
  readonly open: boolean;
}

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

/** Fold a sequence of change batches into a plain `id -> value` map. */
const fold = (
  initial: ReadonlyArray<LiveView.Row>,
  batches: ReadonlyArray<ReadonlyArray<RowChange.RowChange<LiveView.Row>>>
): Map<string, unknown> => {
  const state = new Map(initial.map((row) => [row.id, row.value]));
  for (const batch of batches) {
    for (const change of batch) {
      switch (change._tag) {
        case "reset":
          state.clear();
          break;
        case "enter":
        case "update":
          state.set(change.row.id, change.row.value);
          break;
        case "exit":
          state.delete(change.id);
          break;
      }
    }
  }
  return state;
};

const sortedEntries = (state: Map<string, unknown>) =>
  [...state.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const pageEntries = (rows: ReadonlyArray<LiveView.Row>) =>
  sortedEntries(new Map(rows.map((r) => [r.id, r.value])));

const subsets = {
  predicateOnly: Subset.make({ collection: "items", where: Predicate.eq("open", true) }),
  orderedLimited: Subset.make({
    collection: "items",
    orderBy: [{ field: "rank", direction: "asc" }],
    limit: 3,
  }),
  unordered: Subset.make({ collection: "items" }),
};

interface Mismatch {
  readonly label: string;
  readonly folded: ReadonlyArray<readonly [string, unknown]>;
  readonly page: ReadonlyArray<readonly [string, unknown]>;
}

type Truth = Map<string, Item>;

/** Rebuild: reset + fresh enters, as the engine does on ViewChange.Rebuild. */
const applyRebuild = (
  subset: Subset.Subset,
  truth: Truth,
  folded: Map<string, unknown>
): LiveView.LiveView => {
  const next = LiveView.make(
    subset,
    [...truth.entries()].map(([id, value]) => ({ id, value }))
  );
  folded.clear();
  for (const row of LiveView.result(next)) folded.set(row.id, row.value);
  return next;
};

/** A single put/del against `truth`, folding the resulting diff into `folded`. */
const applyMutation = (
  view: LiveView.LiveView,
  truth: Truth,
  folded: Map<string, unknown>,
  rand: () => number,
  id: string,
  isDelete: boolean
): LiveView.LiveView => {
  const before = LiveView.result(view);
  let next: LiveView.LiveView;
  if (isDelete) {
    truth.delete(id);
    next = LiveView.del(view, id);
  } else {
    const value: Item = { rank: Math.floor(rand() * 6), open: rand() < 0.6 };
    truth.set(id, value);
    next = LiveView.put(view, { id, value });
  }
  const after = LiveView.result(next);
  for (const change of RowChange.diff(before, after)) {
    if (change._tag === "enter" || change._tag === "update")
      folded.set(change.row.id, change.row.value);
    else if (change._tag === "exit") folded.delete(change.id);
  }
  return next;
};

/**
 * Run one randomized session against `subset`, checking every step. Returns
 * the first step where folding the emitted `RowChange` batches diverges from
 * `LiveView.result`, or `undefined` if every step matched — so the caller's
 * `it` block makes the actual assertion (a helper's internal `expect` calls
 * are invisible to static "test has assertions" checks).
 */
const runSession = (subset: Subset.Subset, seed: number, steps: number): Mismatch | undefined => {
  const rand = mulberry32(seed);
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(rand() * xs.length)]!;

  // The backing "confirmed collection", independent of the subset's filter —
  // put/del apply here first, mirroring the store `LiveView` maintains a
  // window over.
  const truth: Truth = new Map();
  let view = LiveView.make(subset, []);
  const folded = fold(LiveView.result(view), []);

  const matches = (label: string): Mismatch | undefined => {
    const foldedEntries = sortedEntries(folded);
    const page = pageEntries(LiveView.result(view));
    return JSON.stringify(foldedEntries) === JSON.stringify(page)
      ? undefined
      : { label: `${label} (seed=${seed})`, folded: foldedEntries, page };
  };
  const initial = matches("initial");
  if (initial !== undefined) return initial;

  for (let step = 0; step < steps; step++) {
    const action = rand();
    if (action < 0.08) {
      view = applyRebuild(subset, truth, folded);
    } else {
      const id = pick(IDS);
      const isDelete = action < 0.08 + 0.25 && truth.has(id);
      view = applyMutation(view, truth, folded, rand, id, isDelete);
    }
    const mismatch = matches(`step ${step}`);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
};

describe("RowChange — folding the feed reproduces LiveView.result", () => {
  for (const [name, subset] of Object.entries(subsets)) {
    it(`matches LiveView.result at every step (${name})`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        expect(runSession(subset, seed, 80)).toBeUndefined();
      }
    });
  }

  it("diff is empty for identical references (fast path)", () => {
    const rows: ReadonlyArray<LiveView.Row> = [{ id: "a", value: { rank: 1 } }];
    expect(RowChange.diff(rows, rows)).toEqual([]);
  });

  it("enter/update/exit carry the expected shape", () => {
    const before: ReadonlyArray<LiveView.Row> = [
      { id: "a", value: { rank: 1 } },
      { id: "b", value: { rank: 2 } },
    ];
    const bUpdated = { id: "b", value: { rank: 5 } };
    const after: ReadonlyArray<LiveView.Row> = [bUpdated, { id: "c", value: { rank: 3 } }];
    const changes = RowChange.diff(before, after);
    expect(changes).toEqual([
      { _tag: "update", row: bUpdated, previous: before[1] },
      { _tag: "enter", row: after[1] },
      { _tag: "exit", id: "a", previous: before[0] },
    ]);
  });

  it("reset batches a marker followed by fresh enters", () => {
    const rows: ReadonlyArray<LiveView.Row> = [{ id: "a", value: { rank: 1 } }];
    expect(RowChange.reset(rows)).toEqual([{ _tag: "reset" }, { _tag: "enter", row: rows[0] }]);
  });
});
