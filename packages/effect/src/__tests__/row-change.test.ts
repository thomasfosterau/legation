/**
 * RowChange (#115, hardened per #133 item 5): property test that folding the
 * change feed reproduces `observe()`'s pages exactly. `LiveView.put`/`del`
 * already decide predicate and window membership per row
 * (`live-view.test.ts` covers that in isolation); this drives long randomized
 * sequences of upserts/deletes — interleaved with two distinct Rebuild
 * triggers, a bare gap-collapse and a "pull races a pending mutation" (the
 * two real causes `ClientEngine`/`docs/observing-row-changes.md` document —
 * `observe-changes.test.ts` covered each as a separate deterministic
 * scenario; folded in here so every seed exercises both, interleaved with
 * ordinary mutations rather than in isolation) — and a randomly-timed late
 * subscriber (a second observer seeded mid-session via fresh `enter`s, the
 * same `includeInitial` contract, tracked in parallel from then on) — and
 * checks that folding `RowChange.diff`/`reset` batches into a plain map
 * reproduces `LiveView.result` after every single step, for every observer —
 * not just at the end — across several subset shapes (predicate-only,
 * ordered+limited, unordered).
 *
 * No `fast-check`/`Schema.Arbitrary` dependency exists in this codebase yet
 * (see CONTEXT.md's testing conventions); this follows the repo's existing
 * convention of a tiny seeded PRNG instead, so a failure prints a
 * reproducible seed.
 */
import { describe, expect, it } from "vite-plus/test";
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

/** A second observer's state: its own fold, seeded at `startedAtStep`. */
interface LateObserver {
  readonly startedAtStep: number;
  readonly folded: Map<string, unknown>;
}

/** Seed a late subscriber the way `includeInitial` does: fresh `enter`s for
 * the window as it stands right now, no `reset` marker (nothing to reset
 * from yet). */
const seedLateObserver = (view: LiveView.LiveView, startedAtStep: number): LateObserver => {
  const folded = new Map<string, unknown>();
  for (const change of RowChange.enters(LiveView.result(view))) {
    if (change._tag === "enter") folded.set(change.row.id, change.row.value);
  }
  return { startedAtStep, folded };
};

/** Fold one transition's batch into a late observer's state, same rules `fold` uses. */
const applyToLateObserver = (
  observer: LateObserver,
  batch: ReadonlyArray<RowChange.RowChange<LiveView.Row>>
): void => {
  for (const change of batch) {
    switch (change._tag) {
      case "reset":
        observer.folded.clear();
        break;
      case "enter":
      case "update":
        observer.folded.set(change.row.id, change.row.value);
        break;
      case "exit":
        observer.folded.delete(change.id);
        break;
      case "move":
        break;
    }
  }
};

/**
 * Run one randomized session against `subset`, checking every step for the
 * primary observer AND, once spawned, a late subscriber. Returns the first
 * mismatch, or `undefined` if every step matched for every observer — so the
 * caller's `it` block makes the actual assertion (a helper's internal
 * `expect` calls are invisible to static "test has assertions" checks).
 *
 * Two distinct Rebuild triggers are modeled, both real per
 * `docs/observing-row-changes.md`: a bare gap-collapse (an unprompted
 * conservative reset, e.g. a dropped change under hub backpressure) and a
 * "pull races a pending mutation" (a mutation sets `pendingSincePull`; the
 * next `pull` step forces a full Rebuild instead of a diff — `ClientEngine.
 * applyPull`'s exact rule — then clears the flag; a `pull` with nothing
 * pending is a correctness no-op, matching an empty `Patch`).
 */
/** Mutable state threaded through one randomized session (see {@link runSession}). */
interface SessionState {
  view: LiveView.LiveView;
  readonly truth: Truth;
  readonly folded: Map<string, unknown>;
  pendingSincePull: boolean;
}

/**
 * One randomized step: a bare gap-collapse, a `pull` (Rebuild only if a
 * mutation is still pending, else a no-op), or an ordinary put/del mutation
 * — mutates `state` in place and returns the batch that step produced, for
 * the late observer to fold alongside the primary one.
 */
const stepSession = (
  subset: Subset.Subset,
  state: SessionState,
  rand: () => number,
  pick: <A>(xs: ReadonlyArray<A>) => A
): ReadonlyArray<RowChange.RowChange<LiveView.Row>> => {
  const action = rand();
  if (action < 0.05) {
    // A bare gap-collapse: unprompted, independent of pending mutations.
    state.view = applyRebuild(subset, state.truth, state.folded);
    return RowChange.reset(LiveView.result(state.view));
  }
  if (action < 0.1) {
    // A `pull`: forces a Rebuild only if a mutation is still pending.
    if (!state.pendingSincePull) return [];
    state.view = applyRebuild(subset, state.truth, state.folded);
    state.pendingSincePull = false;
    return RowChange.reset(LiveView.result(state.view));
  }
  const id = pick(IDS);
  const isDelete = action < 0.1 + 0.25 && state.truth.has(id);
  const before = LiveView.result(state.view);
  state.view = applyMutation(state.view, state.truth, state.folded, rand, id, isDelete);
  state.pendingSincePull = true;
  return RowChange.diff(before, LiveView.result(state.view));
};

/** The primary (and, once spawned, the late) observer's fold vs. `LiveView.result`, or the first mismatch. */
const checkSession = (
  seed: number,
  label: string,
  state: SessionState,
  lateObserver: LateObserver | undefined
): Mismatch | undefined => {
  const page = pageEntries(LiveView.result(state.view));
  const foldedEntries = sortedEntries(state.folded);
  if (JSON.stringify(foldedEntries) !== JSON.stringify(page)) {
    return { label: `${label} (seed=${seed})`, folded: foldedEntries, page };
  }
  if (lateObserver === undefined) return undefined;
  const lateEntries = sortedEntries(lateObserver.folded);
  if (JSON.stringify(lateEntries) === JSON.stringify(page)) return undefined;
  return {
    label: `${label} (seed=${seed}, late observer since step ${lateObserver.startedAtStep})`,
    folded: lateEntries,
    page,
  };
};

const runSession = (subset: Subset.Subset, seed: number, steps: number): Mismatch | undefined => {
  const rand = mulberry32(seed);
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(rand() * xs.length)]!;

  // The backing "confirmed collection", independent of the subset's filter —
  // put/del apply here first, mirroring the store `LiveView` maintains a
  // window over.
  const state: SessionState = {
    view: LiveView.make(subset, []),
    truth: new Map(),
    folded: new Map(),
    pendingSincePull: false,
  };
  let lateObserver: LateObserver | undefined;
  // Spawn the late subscriber at a random step within the session (most
  // sessions get one — only seeds landing past `steps` skip it), so
  // "joining mid-stream" is exercised at varied points, not a fixed step.
  const lateSpawnStep = Math.floor(rand() * steps * 1.3);

  const initial = checkSession(seed, "initial", state, lateObserver);
  if (initial !== undefined) return initial;

  for (let step = 0; step < steps; step++) {
    if (step === lateSpawnStep) lateObserver = seedLateObserver(state.view, step);

    const batch = stepSession(subset, state, rand, pick);
    if (lateObserver !== undefined) applyToLateObserver(lateObserver, batch);

    const mismatch = checkSession(seed, `step ${step}`, state, lateObserver);
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

  it("carries position on enter/update when rows have one", () => {
    interface Positioned extends LiveView.Row {
      readonly position: string;
    }
    const before: ReadonlyArray<Positioned> = [
      { id: "a", value: { rank: 1 }, position: "a0" },
      { id: "b", value: { rank: 2 }, position: "a1" },
    ];
    const bUpdated: Positioned = { id: "b", value: { rank: 5 }, position: "a1" };
    const cEnters: Positioned = { id: "c", value: { rank: 3 }, position: "a2" };
    const after: ReadonlyArray<Positioned> = [before[0]!, bUpdated, cEnters];
    expect(RowChange.diff(before, after)).toEqual([
      { _tag: "update", row: bUpdated, previous: before[1], position: "a1" },
      { _tag: "enter", row: cEnters, position: "a2" },
    ]);
  });

  it("emits move for a same-value row whose position shifted", () => {
    interface Positioned extends LiveView.Row {
      readonly position: string;
    }
    const before: ReadonlyArray<Positioned> = [
      { id: "a", value: { rank: 1 }, position: "a0" },
      { id: "b", value: { rank: 2 }, position: "a1" },
    ];
    // "b"'s value is unchanged but its position moved ahead of "a" (a
    // neighbor's insert/delete re-ranked it without touching its value).
    const bMoved: Positioned = { id: "b", value: before[1]!.value, position: "a-1" };
    const after: ReadonlyArray<Positioned> = [bMoved, before[0]!];
    expect(RowChange.diff(before, after)).toEqual([
      { _tag: "move", row: bMoved, position: "a-1", previousPosition: "a1" },
    ]);
  });

  it("reset/enters carry position when present, and omit it when absent", () => {
    interface Positioned extends LiveView.Row {
      readonly position: string;
    }
    const positioned: ReadonlyArray<Positioned> = [{ id: "a", value: { rank: 1 }, position: "a0" }];
    expect(RowChange.enters(positioned)).toEqual([
      { _tag: "enter", row: positioned[0], position: "a0" },
    ]);
    const plain: ReadonlyArray<LiveView.Row> = [{ id: "a", value: { rank: 1 } }];
    expect(RowChange.enters(plain)).toEqual([{ _tag: "enter", row: plain[0] }]);
  });
});
