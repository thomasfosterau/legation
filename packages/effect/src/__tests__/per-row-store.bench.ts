/**
 * Per-row store I/O benchmark (#47): counts KeyValueStore `set` calls for a
 * patch-apply as a function of (collection size, patch size) over an in-memory
 * KVS. The point is the scaling law — a patch's *row-value* writes track the
 * patch size, never the collection it lands in — so the numbers are printed as
 * a table and also exercised as timed benches.
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept off the coverage/test path.
 */
import { describe, test } from "vitest";
import { Effect } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as ClientStoreModule from "../ClientStore.js";
import type { PatchOp } from "../Protocol.js";

/** An in-memory KVS that counts `set` calls per key. */
const countingStore = () => {
  const data = new Map<string, string>();
  const sets = new Map<string, number>();
  const store = KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => data.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        sets.set(key, (sets.get(key) ?? 0) + 1);
        data.set(key, value);
      }),
    remove: (key) => Effect.sync(() => void data.delete(key)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { store, sets };
};

const putOps = (from: number, count: number): Array<PatchOp> =>
  Array.from({ length: count }, (_, i) => ({
    _tag: "Put" as const,
    collection: "todos",
    id: `r${from + i}`,
    version: 1,
    value: { i: from + i },
  }));

interface Counts {
  readonly collectionSize: number;
  readonly patchSize: number;
  readonly rowValueSets: number;
  readonly indexSets: number;
  readonly totalSets: number;
}

/** Seed `collectionSize` rows, then apply a `patchSize`-op patch, counting sets. */
const measure = (collectionSize: number, patchSize: number): Counts => {
  const { store, sets } = countingStore();
  Effect.runSync(
    Effect.gen(function* () {
      const s = yield* ClientStoreModule.makeKeyValue();
      yield* s.applyRowOps(putOps(0, collectionSize));
      sets.clear();
      // Update the first `patchSize` existing rows.
      yield* s.applyRowOps(putOps(0, patchSize));
    }).pipe(Effect.provideService(KeyValueStore.KeyValueStore, store))
  );
  const keys = [...sets.entries()];
  const rowValueSets = keys
    .filter(([k]) => k.startsWith("legation/row/todos/"))
    .reduce((n, [, c]) => n + c, 0);
  const indexSets = sets.get("legation/rowIndex/todos") ?? 0;
  const totalSets = keys.reduce((n, [, c]) => n + c, 0);
  return { collectionSize, patchSize, rowValueSets, indexSets, totalSets };
};

// Print the scaling table once at load: hold the patch size fixed while the
// collection grows (row-value writes stay flat), then grow the patch (they
// track it). This is the acceptance evidence.
const table: Array<Counts> = [
  measure(100, 10),
  measure(1_000, 10),
  measure(10_000, 10),
  measure(10_000, 1),
  measure(10_000, 50),
  measure(10_000, 200),
];
// eslint-disable-next-line no-console
console.table(table);

const patchOnLarge = putOps(0, 20);

describe("per-row store I/O scaling", () => {
  test("20-op patch over a 10k-row collection (value I/O ∝ patch size)", async ({ bench }) => {
    await bench("20-op patch over a 10k-row collection (value I/O ∝ patch size)", () => {
      const { store } = countingStore();
      Effect.runSync(
        Effect.gen(function* () {
          const s = yield* ClientStoreModule.makeKeyValue();
          yield* s.applyRowOps(putOps(0, 10_000));
          yield* s.applyRowOps(patchOnLarge);
        }).pipe(Effect.provideService(KeyValueStore.KeyValueStore, store))
      );
    }).run({ time: 500 });
  });
});
