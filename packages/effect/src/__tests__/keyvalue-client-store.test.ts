/**
 * KeyValueStore-backed ClientStore tests: the durable implementation
 * rehydrates losslessly (rows, journal, counters, cookie) and drives the
 * engine end to end like the memory store.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as Hydration from "../Hydration.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import type { Mutation } from "../Protocol.js";
import { defined } from "./defined.js";

const mutation = (mutationId: number): Mutation => ({
  clientId: "c1",
  mutationId,
  mutator: "noop",
  args: {},
  createdAt: 0,
});

describe("ClientStore.makeKeyValue", () => {
  it.effect("rehydrates rows, journal, counters, and cookie from the same KVS", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.putRow("todos", { id: "1", version: 1, value: { title: "persisted" } });
      yield* first.putRow("notes", { id: "n1", version: 2, value: { body: "x" } });
      yield* first.appendMutation(mutation(yield* first.nextMutationId("c1")));
      yield* first.setCookie("cookie-1");

      // A second store over the same KeyValueStore sees everything.
      const second = yield* ClientStoreModule.makeKeyValue();
      expect((yield* second.getRow("todos", "1"))?.value).toEqual({ title: "persisted" });
      expect(yield* second.listRows("notes")).toHaveLength(1);
      expect(yield* second.pendingMutations).toHaveLength(1);
      expect(yield* second.getCookie).toBe("cookie-1");
      // The mutation-id counter continues, never restarts.
      expect(yield* second.nextMutationId("c1")).toBe(2);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("reads and raises the counters durably, never lowering one (#271)", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.appendMutation(mutation(yield* first.nextMutationId("c1")));
      yield* first.appendMutation(mutation(yield* first.nextMutationId("c1")));
      yield* first.acknowledge("c1", 2);
      expect(yield* first.mutationCounters).toEqual({ c1: 2 });
      expect((yield* Hydration.dehydrate(first)).counters).toEqual({ c1: 2 });

      yield* first.raiseMutationCounters({ c1: 1, c2: 5 });
      const second = yield* ClientStoreModule.makeKeyValue();
      expect(yield* second.mutationCounters).toEqual({ c1: 2, c2: 5 });
      expect(yield* second.nextMutationId("c1")).toBe(3);
      expect(yield* second.nextMutationId("c2")).toBe(6);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a corrupt persisted blob fails as a StoreError, not a silent bad cast", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = yield* ClientStoreModule.makeKeyValue();

      // Valid JSON, wrong shape: journal entries that aren't Mutations.
      yield* kv.set("legation/journal", JSON.stringify([{ nope: true }]));
      const journalError = yield* Effect.flip(store.pendingMutations);
      expect(journalError._tag).toBe("StoreError");

      // Not even JSON: the row blob is garbage.
      yield* kv.set("legation/rows/todos", "}{ not json");
      const rowsError = yield* Effect.flip(store.listRows("todos"));
      expect(rowsError._tag).toBe("StoreError");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("acknowledge trims the journal per client; clearRows resets rows only", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.appendMutation(mutation(1));
      yield* store.appendMutation(mutation(2));
      yield* store.appendMutation({ ...mutation(1), clientId: "c2" });

      yield* store.acknowledge("c1", 1);
      const pending = yield* store.pendingMutations;
      expect(pending.map((m) => [m.clientId, m.mutationId])).toEqual([
        ["c1", 2],
        ["c2", 1],
      ]);

      yield* store.putRow("todos", { id: "1", version: 1, value: {} });
      yield* store.setCookie("keep-me");
      yield* store.clearRows;
      expect(yield* store.listRows("todos")).toEqual([]);
      expect(yield* store.getRow("todos", "1")).toBeUndefined();
      // Journal and cookie survive a row reset.
      expect(yield* store.pendingMutations).toHaveLength(2);
      expect(yield* store.getCookie).toBe("keep-me");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("compactPending removes specific unpushed entries, unlike acknowledge's <= upTo", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.appendMutation(mutation(1));
      yield* store.appendMutation(mutation(2));
      yield* store.appendMutation(mutation(3));
      yield* store.appendMutation({ ...mutation(1), clientId: "c2" });

      // Drop the middle entry only — a non-prefix id set `acknowledge` can't
      // express. The survivor behind it is renumbered so the ids stay gap-free
      // (#249), and the other client's entries are untouched.
      const result = yield* store.compactPending("c1", [2]);
      expect(result).toEqual({ dropped: [2], renumbered: [{ from: 3, to: 2 }] });
      const pending = yield* store.pendingMutations;
      expect(pending.map((m) => [m.clientId, m.mutationId])).toEqual([
        ["c1", 1],
        ["c1", 2],
        ["c2", 1],
      ]);

      // Ids not pending (or never were) are silently skipped, not an error.
      expect(yield* store.compactPending("c1", [999])).toEqual({ dropped: [], renumbered: [] });
      expect(yield* store.pendingMutations).toHaveLength(3);

      // A fresh store over the same KVS sees the drop persisted, not just the
      // in-memory index — same rehydration guarantee as `acknowledge`.
      const rehydrated = yield* ClientStoreModule.makeKeyValue();
      expect((yield* rehydrated.pendingMutations).map((m) => m.mutationId).toSorted()).toEqual([
        1, 1, 2,
      ]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("prefixes isolate two stores sharing one KVS", () =>
    Effect.gen(function* () {
      const a = yield* ClientStoreModule.makeKeyValue({ prefix: "a/" });
      const b = yield* ClientStoreModule.makeKeyValue({ prefix: "b/" });
      yield* a.putRow("todos", { id: "1", version: 1, value: {} });
      yield* a.setCookie("a-cookie");
      expect(yield* b.listRows("todos")).toEqual([]);
      expect(yield* b.getCookie).toBeUndefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("drives the engine end to end as the durable store", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(
            Mutator.make("todo/set", Schema.Struct({ id: Schema.String, title: Schema.String })),
            (args, writer) => writer.put("todos", args.id, args)
          ),
        ])
      );
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );

      const store = yield* ClientStoreModule.makeKeyValue();
      const transport = yield* makeInMemory(handler, "group-a");
      const engine = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators: Mutator.registry([
          {
            mutator: Mutator.make(
              "todo/set",
              Schema.Struct({ id: Schema.String, title: Schema.String })
            ),
            local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
          },
        ]),
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      const allTodos = Subset.make({ collection: "todos" });
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "durable" });
      yield* engine.push;
      yield* engine.pull;

      expect(yield* store.pendingMutations).toEqual([]);
      const confirmed = yield* store.listRows("todos");
      expect(confirmed.map((row) => (row.value as { title: string }).title)).toEqual(["durable"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

const idsOf = (mutations: ReadonlyArray<{ readonly mutationId: number }>) =>
  mutations.map((m) => m.mutationId);

const numbered = (mutationId: number, clientId = "c1"): Mutation => ({
  ...mutation(mutationId),
  clientId,
  args: { n: mutationId },
});

/** A KVS that can be made to fail after a number of further writes. */
const faultyStore = () => {
  const data = new Map<string, string>();
  const reads: Array<string> = [];
  const budget = { writes: Number.POSITIVE_INFINITY };
  // When set, the write of the compaction intent lands but reports failure
  // (an ambiguous IndexedDB abort), once.
  const flaky = { landButFail: false };
  const spend = (method: string, key: string) =>
    budget.writes <= 0
      ? Effect.fail(
          new KeyValueStore.KeyValueStoreError({ message: "injected fault", method, key })
        )
      : Effect.sync(() => void (budget.writes -= 1));
  const store = KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.sync(() => {
        reads.push(key);
        return data.get(key);
      }),
    set: (key, value) =>
      key.endsWith("compactionIntent") && flaky.landButFail
        ? Effect.sync(() => {
            data.set(key, value);
            flaky.landButFail = false;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new KeyValueStore.KeyValueStoreError({
                  message: "write landed but reported failure",
                  method: "set",
                  key,
                })
              )
            )
          )
        : spend("set", key).pipe(Effect.andThen(Effect.sync(() => void data.set(key, value)))),
    remove: (key) =>
      spend("remove", key).pipe(Effect.andThen(Effect.sync(() => void data.delete(key)))),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { store, data, budget, reads, flaky };
};
type Faulty = ReturnType<typeof faultyStore>;

const seeded = (size: number) =>
  Effect.gen(function* () {
    const kv = faultyStore();
    const first = yield* ClientStoreModule.makeKeyValue().pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
    );
    for (let n = 1; n <= size; n++) {
      yield* first.appendMutation(numbered(yield* first.nextMutationId("c1")));
    }
    return { kv, first };
  });

const reopen = (kv: Faulty) =>
  ClientStoreModule.makeKeyValue().pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
  );

/** A new store handle over a copy of the persisted bytes, as a restarted process would see. */
const structuredCloneOf = (kv: Faulty): Faulty => {
  const copy = faultyStore();
  Arr.forEach(kv.data, ([key, value]) => {
    copy.data.set(key, value);
  });
  return copy;
};

/** Old or new journal, whole, with a counter that continues it and appends that stay gap-free. */
const expectWhole = (store: ClientStoreModule.ClientStore, label: string) =>
  Effect.gen(function* () {
    const pending = yield* store.pendingMutations;
    const ids = idsOf(pending);
    const ns = pending.map((m) => (m.args as { n: number }).n);
    const isOld = ids.join() === "1,2,3,4,5" && ns.join() === "1,2,3,4,5";
    const isNew = ids.join() === "1,2,3" && ns.join() === "1,3,5";
    expect(isOld || isNew, `${label}: ${ids} / ${ns}`).toBe(true);
    const nextId = yield* store.nextMutationId("c1");
    expect(nextId, label).toBe(isOld ? 6 : 4);
    yield* store.appendMutation(numbered(nextId));
    const after = idsOf(yield* store.pendingMutations);
    expect(after, label).toEqual(after.map((_, i) => i + 1));
    return isNew;
  });

/** The journal index on disk, and how many of its entries still have a body. */
const onDisk = (kv: Faulty) => {
  const index = JSON.parse(kv.data.get("legation/journalIndex") ?? "[]") as Array<{
    clientId: string;
    mutationId: number;
  }>;
  const withBody = index.filter((e) =>
    kv.data.has(`legation/journal/${e.clientId}/${e.mutationId}`)
  ).length;
  return { index, withBody };
};

describe("KeyValue journal compaction is crash-safe (#249)", () => {
  /** The compaction under test: drop 2 and 4 from 1..5, leaving 1,3,5 renumbered 1,2,3. */
  const EXPECTED = {
    dropped: [2, 4],
    renumbered: [
      { from: 3, to: 2 },
      { from: 5, to: 3 },
    ],
  };

  it.effect(
    "a crash at any write leaves the old or the new journal whole, never a gap or a duplicate",
    () =>
      Effect.gen(function* () {
        let committedButUnapplied = 0;
        let ranToCompletion = false;
        for (let writes = 0; writes < 60 && !ranToCompletion; writes++) {
          const { kv, first } = yield* seeded(5);
          kv.budget.writes = writes;
          const exit = yield* Effect.exit(first.compactPending("c1", [2, 4]));
          ranToCompletion = kv.budget.writes > 0;
          const intentLeft = kv.data.has("legation/compactionIntent");
          kv.budget.writes = Number.POSITIVE_INFINITY;

          // Once the intent is durable the compaction is committed: the caller
          // is told the renumbering even though applying it failed (#249 B1),
          // so it can move everything it keyed by the old ids.
          Exit.match(exit, {
            onSuccess: (renumbering) => expect(renumbering, `writes=${writes}`).toEqual(EXPECTED),
            onFailure: () => expect(intentLeft).toBe(false),
          });
          if (Exit.isSuccess(exit) && intentLeft) committedButUnapplied += 1;

          // The same live store finishes the roll-forward before it appends...
          yield* expectWhole(yield* reopen(structuredCloneOf(kv)), `restart writes=${writes}`);
          // ...and so does the one that failed.
          yield* expectWhole(first, `live writes=${writes}`);
        }
        expect(ranToCompletion).toBe(true);
        // The sweep did exercise a committed-but-unapplied state.
        expect(committedButUnapplied).toBeGreaterThan(0);
      })
  );

  it.effect("a crash during the roll-forward itself is rolled forward again, at every write", () =>
    Effect.gen(function* () {
      let nested = 0;
      for (let first = 1; first < 60; first++) {
        // Crash the compaction `first` writes in, after its intent is durable...
        const probe = yield* seeded(5);
        probe.kv.budget.writes = first;
        yield* Effect.exit(probe.first.compactPending("c1", [2, 4]));
        const left = probe.kv.data.has("legation/compactionIntent");
        if (probe.kv.budget.writes > 0 && !left) break; // ran to completion: sweep done
        if (!left) continue;
        // ...then crash the recovery on the next open `second` writes in.
        for (let second = 0; second < 40; second++) {
          const { kv, first: store } = yield* seeded(5);
          kv.budget.writes = first;
          yield* Effect.exit(store.compactPending("c1", [2, 4]));
          kv.budget.writes = second;
          const recovering = yield* reopen(kv); // open swallows a failed recovery
          const hitFault = kv.budget.writes <= 0;
          kv.budget.writes = Number.POSITIVE_INFINITY;
          if (hitFault) nested += 1;
          // The half-recovered store and a fresh open both end whole.
          const restarted = structuredCloneOf(kv);
          yield* expectWhole(recovering, `recovering first=${first} second=${second}`);
          yield* expectWhole(yield* reopen(restarted), `reopen first=${first} second=${second}`);
          if (!hitFault) break;
        }
      }
      expect(nested).toBeGreaterThan(0);
    })
  );

  it.effect("a compaction reads the index and only the bodies it moves, not the journal (S3)", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(200);
      const bodyReads = () => kv.reads.filter((k) => k.startsWith("legation/journal/")).length;

      // The usual paced shape: the superseded entry is at the tail, so nothing
      // is renumbered and no body is read at all.
      kv.reads.length = 0;
      yield* first.compactPending("c1", [200]);
      expect(bodyReads()).toBe(0);

      // Dropping near the end moves only the entries behind it.
      kv.reads.length = 0;
      yield* first.compactPending("c1", [197]);
      expect(bodyReads()).toBe(2);
      expect(idsOf(yield* first.pendingMutations)).toHaveLength(198);
    })
  );

  it.effect("an intent write that lands but reports failure counts as committed (N-b)", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(5);
      kv.flaky.landButFail = true;
      const result = yield* first.compactPending("c1", [2, 4]);
      expect(result).toEqual(EXPECTED);
      const restarted = structuredCloneOf(kv);
      expect(yield* expectWhole(first, "live")).toBe(true);
      expect(yield* expectWhole(yield* reopen(restarted), "restart")).toBe(true);
    })
  );

  it.effect("an intent write that fails and did not land is a clean failure", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(5);
      kv.budget.writes = 0;
      expect(Exit.isFailure(yield* Effect.exit(first.compactPending("c1", [2, 4])))).toBe(true);
      kv.budget.writes = Number.POSITIVE_INFINITY;
      expect(yield* expectWhole(first, "live")).toBe(false);
    })
  );

  it.effect("refuses, uncommitted, to renumber an entry whose body is missing (N-d)", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(5);
      kv.data.delete("legation/journal/c1/3");
      const exit = yield* Effect.exit(first.compactPending("c1", [2]));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(kv.data.has("legation/compactionIntent")).toBe(false);
      // The index is untouched: still the full run, nothing half-renumbered.
      expect(idsOf(yield* first.pendingMutations)).toEqual([1, 2, 4, 5]);
      expect(JSON.parse(defined(kv.data.get("legation/journalIndex")))).toHaveLength(5);
    })
  );

  it.effect("the sent watermark is durable: a restart still refuses to touch sent entries", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(5);
      yield* first.markSent("c1", 2);
      yield* first.markSent("c1", 1); // monotonic: ignored

      const restarted = yield* reopen(kv);
      const result = yield* restarted.compactPending("c1", [1, 2, 4]);
      expect(result).toEqual({ dropped: [4], renumbered: [{ from: 5, to: 4 }] });
      expect(idsOf(yield* restarted.pendingMutations)).toEqual([1, 2, 3, 4]);
    })
  );
});

describe("KeyValue acknowledge leaves no index entry without a body (#294)", () => {
  /** c1 holds 1..5 and c2 holds 1..2; the acknowledgement under test is c1 up to 3. */
  const seededTwoClients = Effect.gen(function* () {
    const { kv, first } = yield* seeded(5);
    yield* first.appendMutation(numbered(yield* first.nextMutationId("c2"), "c2"));
    yield* first.appendMutation(numbered(yield* first.nextMutationId("c2"), "c2"));
    return { kv, first };
  });

  it.effect("a crash at any write of an acknowledgement is healed on the next open", () =>
    Effect.gen(function* () {
      let orphaned = 0;
      let ranToCompletion = false;
      for (let writes = 0; writes < 20 && !ranToCompletion; writes++) {
        const { kv, first } = yield* seededTwoClients;
        kv.budget.writes = writes;
        yield* Effect.exit(first.acknowledge("c1", 3));
        ranToCompletion = kv.budget.writes > 0;
        kv.budget.writes = Number.POSITIVE_INFINITY;
        const label = `writes=${writes}`;

        // The crash window: bodies removed, the index not yet rewritten.
        const crashed = onDisk(kv);
        if (crashed.withBody < crashed.index.length) orphaned += 1;

        const restarted = structuredCloneOf(kv);
        const store = yield* reopen(restarted);
        const healed = onDisk(restarted);
        // Every surviving index entry has its body, and the count agrees.
        expect(healed.withBody, label).toBe(healed.index.length);
        expect(yield* store.pendingCount, label).toBe(healed.withBody);
        expect(yield* store.pendingCount, label).toBe((yield* store.pendingMutations).length);

        // Some prefix of the acknowledged run may survive (re-pushing it is an
        // idempotent skip), but nothing above `upTo` and nothing of c2 is lost.
        const c1 = idsOf((yield* store.pendingMutations).filter((m) => m.clientId === "c1"));
        const c2 = idsOf((yield* store.pendingMutations).filter((m) => m.clientId === "c2"));
        expect(
          [
            [1, 2, 3, 4, 5],
            [2, 3, 4, 5],
            [3, 4, 5],
            [4, 5],
          ],
          label
        ).toContainEqual(c1);
        expect(c2, label).toEqual([1, 2]);

        // The pending count is read from the index alone (#260).
        restarted.reads.length = 0;
        yield* store.pendingCount;
        expect(
          restarted.reads.filter((k) => k.startsWith("legation/journal/")),
          label
        ).toEqual([]);

        // No acknowledged id is reissued, and a compaction no longer trips
        // over a missing body (#249 N-d).
        const next = yield* store.appendNext({
          clientId: "c1",
          mutator: "noop",
          args: {},
          createdAt: 0,
        });
        expect(next.mutationId, label).toBe(6);
        yield* store.compactPending("c1", [4]);
        expect(
          idsOf((yield* store.pendingMutations).filter((m) => m.clientId === "c1")).at(-1)
        ).toBe(5);
      }
      expect(ranToCompletion).toBe(true);
      // The sweep did exercise the window #294 is about.
      expect(orphaned).toBeGreaterThan(0);
    })
  );

  it.effect("an open drops an index entry whose body is missing, reserving its id", () =>
    Effect.gen(function* () {
      const { kv } = yield* seededTwoClients;
      // A store damaged by an earlier release's crash: the bodies of c1's 4 and
      // 5 are gone, the index still lists them, and the counter never saw 5.
      kv.data.delete("legation/journal/c1/4");
      kv.data.delete("legation/journal/c1/5");
      kv.data.set("legation/counters", JSON.stringify({ c1: 3, c2: 2 }));
      expect(onDisk(kv)).toMatchObject({ withBody: 5 });
      expect(onDisk(kv).index).toHaveLength(7);

      const store = yield* reopen(kv);
      expect(yield* store.pendingCount).toBe(5);
      expect(onDisk(kv).index).toHaveLength(5);
      // Ids that leave the journal stay reserved, as `acknowledge` keeps them.
      expect(yield* store.nextMutationId("c1")).toBe(6);
    })
  );

  it.effect("an open of a healthy journal writes nothing", () =>
    Effect.gen(function* () {
      const { kv } = yield* seededTwoClients;
      // Every successful write spends one from the budget.
      kv.budget.writes = 1000;
      const store = yield* reopen(kv);
      expect(kv.budget.writes).toBe(1000);
      expect(yield* store.pendingCount).toBe(7);
    })
  );
});
