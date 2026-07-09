/**
 * Property test (issue #112 acceptance criteria): the order `LiveView`
 * maintains incrementally must equal `Subset.apply` recomputed from scratch
 * — after *every prefix* of a randomized delta sequence, not just the final
 * state, so a bug that self-corrects after enough churn can't hide. Runs
 * with and without `orderBy` (exercising the id tie-break), with small rank
 * ranges (forcing genuine ties), and with a `limit` narrow enough that
 * inserts/deletes routinely cross the window boundary (push-out/pull-in).
 *
 * Uses a deterministic xorshift32 PRNG (not `Math.random`) so a failure is
 * reproducible from its seed alone.
 */
import { describe, expect, it } from "vitest";
import * as LiveView from "../LiveView.js";
import * as Subset from "../Subset.js";

const makePrng = (seed: number) => {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
};

interface Delta {
  readonly _tag: "put" | "del";
  readonly id: string;
  readonly rank?: number;
}

const ID_SPACE = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];

const randomDeltas = (next: () => number, count: number, rankRange: number): ReadonlyArray<Delta> =>
  Array.from({ length: count }, () => {
    const id = ID_SPACE[Math.floor(next() * ID_SPACE.length)]!;
    if (next() < 0.15) return { _tag: "del" as const, id };
    return { _tag: "put" as const, id, rank: Math.floor(next() * rankRange) };
  });

/** Apply one delta to both the incremental view and the from-scratch row map. */
const step = (
  view: LiveView.LiveView,
  reference: Map<string, LiveView.Row>,
  delta: Delta
): { readonly view: LiveView.LiveView; readonly reference: Map<string, LiveView.Row> } => {
  const nextReference = new Map(reference);
  if (delta._tag === "del") {
    nextReference.delete(delta.id);
    return { view: LiveView.del(view, delta.id), reference: nextReference };
  }
  const row: LiveView.Row = { id: delta.id, value: { rank: delta.rank } };
  nextReference.set(delta.id, row);
  return { view: LiveView.put(view, row), reference: nextReference };
};

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const SCENARIOS: ReadonlyArray<{ readonly name: string; readonly subset: Subset.Subset }> = [
  {
    name: "ordered, no limit",
    subset: Subset.make({ collection: "items", orderBy: [{ field: "rank", direction: "asc" }] }),
  },
  {
    name: "ordered, narrow limit (window boundary crossed constantly)",
    subset: Subset.make({
      collection: "items",
      orderBy: [{ field: "rank", direction: "asc" }],
      limit: 3,
    }),
  },
  {
    name: "ordered desc, narrow limit",
    subset: Subset.make({
      collection: "items",
      orderBy: [{ field: "rank", direction: "desc" }],
      limit: 4,
    }),
  },
  {
    name: "no orderBy (id tie-break total order), narrow limit",
    subset: Subset.make({ collection: "items", limit: 3 }),
  },
];

describe("LiveView property: maintained order ≡ Subset.apply after every delta prefix", () => {
  describe.each(SCENARIOS)("$name", ({ subset }) => {
    it.each(SEEDS)("seed %i", (seed) => {
      const next = makePrng(seed * 7919 + 1);
      // A small rank range (0..4) forces frequent ties, exercising the id
      // tie-break; 200 deltas over a 12-id space guarantees the window
      // boundary is crossed by both inserts and deletes many times over.
      const deltas = randomDeltas(next, 200, 5);
      let view = LiveView.make(subset, []);
      let reference = new Map<string, LiveView.Row>();
      for (let i = 0; i < deltas.length; i++) {
        ({ view, reference } = step(view, reference, deltas[i]!));
        const maintained = LiveView.result(view).map((r) => r.id);
        const expected = Subset.apply([...reference.values()], subset).map((r) => r.id);
        expect(maintained, `seed ${seed}, step ${i} (${JSON.stringify(deltas[i])})`).toEqual(
          expected
        );
      }
    });
  });
});
