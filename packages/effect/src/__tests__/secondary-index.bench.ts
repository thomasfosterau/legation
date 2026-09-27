/**
 * Secondary-index benchmark (#113): a point-predicate `query` over a 50k-row
 * collection, indexed vs unindexed — the acceptance criterion is the indexed
 * path dropping from O(n) (`Subset.apply`'s full scan) to O(hits) (index
 * lookup + residual test over just the matches).
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept out of the coverage/test path.
 */
import { describe, test } from "vitest";
import { Effect, Schema, Scope, Stream } from "effect";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore, type StoredRow } from "../ClientStore.js";
import * as Mutator from "../Mutator.js";
import type { Mutation, PatchOp } from "../Protocol.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const ROWS = 50_000;

// `ClientStore.makeMemory`'s copy-on-write row map recreates the *whole*
// per-collection `Map` on every single `putRow`/`applyRowOps` entry (see its
// implementation) — O(collection size) per write, so bulk-loading 50k rows
// through it is O(n²) and swamps the benchmark with setup cost, not the
// query-path cost under test. A plain mutable store sidesteps that (a
// pre-existing `ClientStore.makeMemory` write-path cost, orthogonal to this
// issue) so the timed section only ever measures `query`.
const makeBulkSeededStore = (
  rows: ReadonlyArray<{ readonly id: string; readonly priority: number; readonly done: boolean }>
): Effect.Effect<ClientStore> =>
  Effect.sync(() => {
    const collections = new Map<string, Map<string, StoredRow>>([
      ["items", new Map(rows.map((row) => [row.id, { id: row.id, version: 1, value: row }]))],
    ]);
    const collectionOf = (name: string) => {
      const existing = collections.get(name);
      if (existing !== undefined) return existing;
      const created = new Map<string, StoredRow>();
      collections.set(name, created);
      return created;
    };
    let journal: ReadonlyArray<Mutation> = [];
    let cookie: string | undefined;
    let identity: string | undefined;
    const counters = new Map<string, number>();
    const quarantine = new Map<string, ReadonlyArray<Mutation>>();
    return ClientStore.of({
      getRow: (collection, id) => Effect.sync(() => collections.get(collection)?.get(id)),
      listRows: (collection) =>
        Effect.sync(() => [...(collections.get(collection)?.values() ?? [])]),
      listCollections: Effect.sync(() => [...collections.keys()]),
      putRow: (collection, row) =>
        Effect.sync(() => void collectionOf(collection).set(row.id, row)),
      delRow: (collection, id) => Effect.sync(() => void collections.get(collection)?.delete(id)),
      clearRows: Effect.sync(() => collections.clear()),
      applyRowOps: (ops: ReadonlyArray<PatchOp>) =>
        Effect.sync(() => {
          for (const op of ops) {
            if (op._tag === "Clear") collections.clear();
            else if (op._tag === "Put")
              collectionOf(op.collection).set(op.id, {
                id: op.id,
                version: op.version,
                value: op.value,
              });
            else collections.get(op.collection)?.delete(op.id);
          }
        }),
      appendMutation: (mutation) => Effect.sync(() => void (journal = journal.concat(mutation))),
      pendingMutations: Effect.sync(() => journal),
      acknowledge: (clientId, upTo) =>
        Effect.sync(
          () =>
            void (journal = journal.filter((m) => m.clientId !== clientId || m.mutationId > upTo))
        ),
      dropPending: (clientId, mutationIds) =>
        Effect.sync(() => {
          const ids = new Set(mutationIds);
          journal = journal.filter((m) => m.clientId !== clientId || !ids.has(m.mutationId));
        }),
      nextMutationId: (clientId) =>
        Effect.sync(() => {
          const next = (counters.get(clientId) ?? 0) + 1;
          counters.set(clientId, next);
          return next;
        }),
      getCookie: Effect.sync(() => cookie),
      setCookie: (value) => Effect.sync(() => void (cookie = value)),
      clearCookie: Effect.sync(() => void (cookie = undefined)),
      // The identity boundary plays no part in a query-path benchmark: this
      // store is never stamped and never quarantines.
      getIdentity: Effect.sync(() => identity),
      setIdentity: (fingerprint) => Effect.sync(() => void (identity = fingerprint)),
      quarantinePending: (fingerprint) =>
        Effect.sync(() => {
          const moved = journal;
          quarantine.set(fingerprint, [...(quarantine.get(fingerprint) ?? []), ...moved]);
          journal = [];
          return moved.length;
        }),
      quarantinedMutations: (fingerprint) => Effect.sync(() => quarantine.get(fingerprint) ?? []),
      quarantines: Effect.sync(() => [...quarantine.keys()]),
      releaseQuarantine: (fingerprint) =>
        Effect.sync(() => {
          const held = quarantine.get(fingerprint) ?? [];
          journal = journal.concat(held);
          quarantine.delete(fingerprint);
          return held.length;
        }),
      discardQuarantine: (fingerprint) => Effect.sync(() => void quarantine.delete(fingerprint)),
    });
  });

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("item/set", Schema.Unknown),
    local: (a, w) => w.put("items", (a as { id: string }).id, a),
  },
]);

const noopHandler: ServerHandler = {
  handlePush: () => Effect.succeed({ lastMutationIds: {} }),
  handlePull: () => Effect.succeed({ patch: [], cookie: "c", lastMutationIds: {} }),
  handleRead: () => Effect.succeed({ rows: [] }),
  pokes: () => Stream.empty,
};

const rows = Array.from({ length: ROWS }, (_, i) => ({
  id: `r${i}`,
  priority: i % 100, // a selective point predicate matches ~1/100th of the collection
  done: i % 2 === 0,
}));

// One long-lived scope for the whole bench run (never closed — the process
// exits after `vitest bench` completes), so engine setup (seeding 50k rows)
// happens once and only the timed `query` call repeats per iteration.
const benchScope = await Effect.runPromise(Scope.make());

const buildEngine = (indexed: boolean) =>
  Effect.gen(function* () {
    const store = yield* makeBulkSeededStore(rows);
    const transport = yield* makeInMemory(noopHandler, `bench-${indexed}`);
    const engine = yield* ClientEngineModule.make({
      clientId: "bench",
      clientGroupId: `bench-${indexed}`,
      mutators,
      ...(indexed ? { indexes: { items: ["priority"] } } : {}),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    // Prime the index (or, for the unindexed engine, just the overlay cache)
    // once outside the timed loop, matching how a long-lived app's first
    // rebuild pays the one-time cost and steady-state rebuilds don't.
    yield* engine.query(Subset.make({ collection: "items", where: Predicate.eq("priority", 0) }));
    return engine;
  }).pipe(Scope.provide(benchScope), Effect.runPromise);

const unindexedEngine = await buildEngine(false);
const indexedEngine = await buildEngine(true);

const pointPredicate = Subset.make({ collection: "items", where: Predicate.eq("priority", 42) });

describe(`point-predicate query over ${ROWS} rows`, () => {
  test("unindexed (full scan)", async ({ bench }) => {
    await bench("unindexed (full scan)", async () => {
      await Effect.runPromise(unindexedEngine.query(pointPredicate));
    }).run({ time: 1000 });
  });

  test("indexed (hash lookup)", async ({ bench }) => {
    await bench("indexed (hash lookup)", async () => {
      await Effect.runPromise(indexedEngine.query(pointPredicate));
    }).run({ time: 1000 });
  });
});
