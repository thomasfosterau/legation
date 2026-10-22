/**
 * LiveView churn benchmark (issue #112's acceptance criterion: "per-delta
 * cost O(log n + window) on a maintained ordered set; no O(n) array copies
 * on unrelated-row churn" — TanStack DB's headline scenario: a 100k-row
 * maintained set, single-row updates).
 *
 * Before this issue, `put`/`del` rebuilt the *entire* `rows` array on every
 * change (`[...rows.slice(0, i), ...]`); an update's cost tracked the
 * collection size regardless of window size. The scaling table below is the
 * acceptance evidence: average per-update time barely moves from 1k rows to
 * 100k (O(log n) tree relocation + O(window) reslice, not O(n) copy).
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept off the coverage/test path.
 */
import { describe, test } from "vite-plus/test";
import * as LiveView from "../LiveView.js";
import * as Subset from "../Subset.js";

const subset = Subset.make({
  collection: "items",
  orderBy: [{ field: "rank", direction: "asc" }],
  limit: 20,
});

const seedRows = (n: number): ReadonlyArray<LiveView.Row> =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, value: { rank: i } }));

/** Total time (ms) for `updates` single-row `put`s against an n-row view. */
const churn = (n: number, updates: number): number => {
  const view = LiveView.make(subset, seedRows(n));
  // Update rows spread across the whole collection (mostly outside the
  // 20-row window), each repositioning to a fresh rank — the worst case for
  // an array-backed view (every update copies the whole array) and the case
  // an ordered tree pays only O(log n + window) for.
  const start = performance.now();
  let current = view;
  for (let i = 0; i < updates; i++) {
    const target = Math.floor((i * (n / updates)) % n);
    current = LiveView.put(current, { id: `r${target}`, value: { rank: n + i } });
  }
  return performance.now() - start;
};

const UPDATES = 200;
const table = [1_000, 10_000, 50_000, 100_000].map((n) => {
  const totalMs = churn(n, UPDATES);
  return {
    collectionSize: n,
    updates: UPDATES,
    totalMs: Number(totalMs.toFixed(2)),
    msPerUpdate: Number((totalMs / UPDATES).toFixed(4)),
  };
});
// eslint-disable-next-line no-console
console.table(table);

describe("LiveView churn (100k rows, single-row updates)", () => {
  const view = LiveView.make(subset, seedRows(100_000));

  test("200 single-row updates over a 100k-row maintained set", async ({ bench }) => {
    await bench("200 single-row updates over a 100k-row maintained set", () => {
      let current = view;
      for (let i = 0; i < UPDATES; i++) {
        const target = Math.floor((i * 500) % 100_000);
        current = LiveView.put(current, { id: `r${target}`, value: { rank: 100_000 + i } });
      }
    }).run({ time: 1000 });
  });

  test("single delete + reinsert (window-boundary churn) over 100k rows", async ({ bench }) => {
    await bench("single delete + reinsert (window-boundary churn) over 100k rows", () => {
      let current = view;
      current = LiveView.del(current, "r10");
      current = LiveView.put(current, { id: "r10", value: { rank: 5 } });
    }).run({ time: 1000 });
  });
});
