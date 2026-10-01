/**
 * KeyValueStore-backed ClientStore tests: the durable implementation
 * rehydrates losslessly (rows, journal, counters, cookie) and drives the
 * engine end to end like the memory store.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import type { Mutation } from "../Protocol.js";

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

describe("KeyValue journal compaction is crash-safe (#249)", () => {
  const numbered = (mutationId: number, clientId = "c1"): Mutation => ({
    ...mutation(mutationId),
    clientId,
    args: { n: mutationId },
  });

  /** A KVS that can be made to fail after a number of further writes. */
  const faultyStore = () => {
    const data = new Map<string, string>();
    const budget = { writes: Number.POSITIVE_INFINITY };
    const spend = (method: string, key: string) =>
      budget.writes <= 0
        ? Effect.fail(
            new KeyValueStore.KeyValueStoreError({ message: "injected fault", method, key })
          )
        : Effect.sync(() => void (budget.writes -= 1));
    const store = KeyValueStore.makeStringOnly({
      get: (key) => Effect.sync(() => data.get(key)),
      set: (key, value) =>
        spend("set", key).pipe(Effect.andThen(Effect.sync(() => void data.set(key, value)))),
      remove: (key) =>
        spend("remove", key).pipe(Effect.andThen(Effect.sync(() => void data.delete(key)))),
      clear: Effect.sync(() => data.clear()),
      size: Effect.sync(() => data.size),
    });
    return { store, data, budget };
  };

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

  const reopen = (kv: ReturnType<typeof faultyStore>) =>
    ClientStoreModule.makeKeyValue().pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
    );

  it.effect(
    "a crash at any write leaves the old or the new journal whole, never a gap or a duplicate",
    () =>
      Effect.gen(function* () {
        let completedAt: number | undefined;
        for (let writes = 0; writes < 40 && completedAt === undefined; writes++) {
          const { kv, first } = yield* seeded(5);
          kv.budget.writes = writes;
          const exit = yield* Effect.exit(first.compactPending("c1", [2, 4]));
          kv.budget.writes = Number.POSITIVE_INFINITY;
          if (Exit.isSuccess(exit)) completedAt = writes;

          // "Restart": a fresh store over the same persisted bytes.
          const restarted = yield* reopen(kv);
          const pending = yield* restarted.pendingMutations;
          const ids = idsOf(pending);
          const ns = pending.map((m) => (m.args as { n: number }).n);

          // Whole journal, old or new, never a blend of the two.
          const isOld = ids.join() === "1,2,3,4,5" && ns.join() === "1,2,3,4,5";
          const isNew = ids.join() === "1,2,3" && ns.join() === "1,3,5";
          expect(isOld || isNew, `writes=${writes}: ${ids} / ${ns}`).toBe(true);

          // The counter agrees with the journal: the next id continues the run.
          const nextId = yield* restarted.nextMutationId("c1");
          expect(nextId).toBe(isOld ? 6 : 4);
          yield* restarted.appendMutation(numbered(nextId));
          const after = idsOf(yield* restarted.pendingMutations);
          expect(after).toEqual(after.map((_, i) => i + 1));
        }
        // The sweep covered both outcomes and ended on a completed compaction.
        expect(completedAt).toBeDefined();
        expect(completedAt).toBeGreaterThan(0);
      })
  );

  it.effect("a failed compaction is finished before the same store appends again", () =>
    Effect.gen(function* () {
      const { kv, first } = yield* seeded(4);
      // Enough budget to commit the intent and begin applying it, then fail.
      kv.budget.writes = 3;
      expect(Exit.isFailure(yield* Effect.exit(first.compactPending("c1", [1])))).toBe(true);
      kv.budget.writes = Number.POSITIVE_INFINITY;

      // No restart: the very next operation rolls the compaction forward, so
      // this append cannot be clobbered by a later replay of the intent.
      const id = yield* first.nextMutationId("c1");
      expect(id).toBe(4); // 2,3,4 renumbered to 1,2,3; the counter rewound to 3
      yield* first.appendMutation(numbered(id));
      expect(idsOf(yield* first.pendingMutations)).toEqual([1, 2, 3, 4]);
      expect(idsOf(yield* (yield* reopen(kv)).pendingMutations)).toEqual([1, 2, 3, 4]);
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
