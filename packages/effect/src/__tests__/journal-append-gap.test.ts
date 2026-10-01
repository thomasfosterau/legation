/**
 * A refused or failed journal append must not burn a mutation id (#258).
 *
 * The engine used to allocate the id (`nextMutationId`) and only then append,
 * so a refusal at `journalHighWater` or a failed write left the counter one
 * ahead of the journal. The next mutation then carried `lastId + 2` and every
 * backend rejects a gap (ADR-0008), so the journal never drained. These tests
 * push through `MemoryBackend`, which enforces that rule.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import type * as Identity from "../Identity.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const todoSet = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));

/** A server (gap-rejecting `MemoryBackend`) plus an engine over `store`. */
const harness = (store: ClientStore) =>
  Effect.gen(function* () {
    const applied: Array<string> = [];
    const backend = yield* MemoryBackend.make(
      MemoryBackend.validatedHandlers([
        MemoryBackend.handler(todoSet, (args, writer) => {
          applied.push(args.id);
          return writer.put("todos", args.id, args);
        }),
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
    const transport = yield* makeInMemory(handler, "group-gap");
    const engine = yield* ClientEngineModule.make({
      clientId: "client-gap",
      clientGroupId: "group-gap",
      mutators: Mutator.registry([
        {
          mutator: todoSet,
          local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
        },
      ]),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store, applied };
  });

const ids = (store: ClientStore) =>
  store.pendingMutations.pipe(Effect.map((all) => all.map((m) => m.mutationId)));

/** A KeyValueStore whose writes to keys containing `journal/` fail while `armed`. */
const flakyJournalWrites = () => {
  const data = new Map<string, string>();
  const state = { armed: false, failures: 0 };
  const kvs = KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => data.get(key)),
    set: (key, value) =>
      state.armed && key.includes("journal/")
        ? Effect.sync(() => void state.failures++).pipe(
            Effect.andThen(
              Effect.fail(
                new KeyValueStore.KeyValueStoreError({ message: "injected", method: "set", key })
              )
            )
          )
        : Effect.sync(() => void data.set(key, value)),
    remove: (key) => Effect.sync(() => void data.delete(key)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { kvs, state };
};

describe("a refused or failed journal append burns no mutation id (#258)", () => {
  it.effect("a high-water refusal is followed by a mutation the backend accepts", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 1 });
      const { engine, applied } = yield* harness(store);

      yield* engine.mutate("todo/set", { id: "a" });
      const refused = yield* Effect.flip(engine.mutate("todo/set", { id: "refused" }));
      expect(refused._tag).toBe("StoreError");
      expect(refused.message).toContain("high-water");

      // The push frees the space; the next mutation must continue the run.
      yield* engine.push;
      expect(yield* ids(store)).toEqual([]);
      yield* engine.mutate("todo/set", { id: "b" });
      expect(yield* ids(store)).toEqual([2]);

      const pushed = yield* Effect.exit(engine.push);
      expect(Exit.isSuccess(pushed)).toBe(true);
      expect(applied).toEqual(["a", "b"]);
      expect(yield* ids(store)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("the issue's reproduction: refused second write, then a third after the ack", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 1 });
      const { engine, applied } = yield* harness(store);
      yield* engine.mutate("todo/set", { id: "1" });
      yield* Effect.flip(engine.mutate("todo/set", { id: "2" }));
      yield* engine.push;
      yield* engine.mutate("todo/set", { id: "3" });
      expect(yield* ids(store)).toEqual([2]); // not 3: the refused write consumed nothing
      yield* engine.push;
      expect(applied).toEqual(["1", "3"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a failed append (write error) is followed by a mutation the backend accepts", () =>
    Effect.gen(function* () {
      const { kvs, state } = flakyJournalWrites();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      const { engine, applied } = yield* harness(store);

      yield* engine.mutate("todo/set", { id: "a" });
      state.armed = true;
      const failed = yield* Effect.flip(engine.mutate("todo/set", { id: "lost" }));
      expect(failed._tag).toBe("StoreError");
      expect(state.failures).toBeGreaterThan(0);
      state.armed = false;

      yield* engine.mutate("todo/set", { id: "b" });
      expect(yield* ids(store)).toEqual([1, 2]);
      const pushed = yield* Effect.exit(engine.push);
      expect(Exit.isSuccess(pushed)).toBe(true);
      expect(applied).toEqual(["a", "b"]);
      expect(yield* ids(store)).toEqual([]);
    })
  );

  for (const [name, makeStore] of [
    ["memory", ClientStoreModule.makeMemory],
    ["key-value", ClientStoreModule.makeKeyValue()],
  ] as const) {
    it.effect(`concurrent journaling neither duplicates nor skips ids (${name})`, () =>
      Effect.gen(function* () {
        const store = yield* makeStore;
        const { engine, applied } = yield* harness(store);
        const N = 25;
        yield* Effect.forEach(
          Array.from({ length: N }, (_, i) => i),
          (i) => engine.mutate("todo/set", { id: `t${i}` }),
          { concurrency: "unbounded" }
        );
        expect(yield* ids(store)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
        const pushed = yield* Effect.exit(engine.push);
        expect(Exit.isSuccess(pushed)).toBe(true);
        expect(applied).toHaveLength(N);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );
  }

  it.effect("concurrent journaling with refusals leaves the accepted ids consecutive", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 5 });
      const { engine, applied } = yield* harness(store);
      const results = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, i) => i),
        (i) => Effect.exit(engine.mutate("todo/set", { id: `t${i}` })),
        { concurrency: "unbounded" }
      );
      expect(results.filter(Exit.isSuccess)).toHaveLength(5);
      expect(yield* ids(store)).toEqual([1, 2, 3, 4, 5]);
      expect(Exit.isSuccess(yield* Effect.exit(engine.push))).toBe(true);
      expect(applied).toHaveLength(5);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("ClientStore.appendNext (#258)", () => {
  it.effect("assigns consecutive ids and a refusal leaves the counter alone", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue({ journalHighWater: 1 });
      const draft = { clientId: "c1", mutator: "noop", args: {}, createdAt: 0 };
      expect((yield* store.appendNext(draft)).mutationId).toBe(1);
      const refused = yield* Effect.flip(store.appendNext(draft));
      expect(refused._tag).toBe("StoreError");
      yield* store.acknowledge("c1", 1);
      expect((yield* store.appendNext(draft)).mutationId).toBe(2);
      expect(yield* store.nextMutationId("c1")).toBe(3);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a counter write that fails after the entry is journaled is healed", () =>
    Effect.gen(function* () {
      const data = new Map<string, string>();
      const state = { failCounters: false };
      const kvs = KeyValueStore.makeStringOnly({
        get: (key) => Effect.sync(() => data.get(key)),
        set: (key, value) =>
          state.failCounters && key.endsWith("counters")
            ? Effect.fail(
                new KeyValueStore.KeyValueStoreError({ message: "injected", method: "set", key })
              )
            : Effect.sync(() => void data.set(key, value)),
        remove: (key) => Effect.sync(() => void data.delete(key)),
        clear: Effect.sync(() => data.clear()),
        size: Effect.sync(() => data.size),
      });
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      const draft = { clientId: "c1", mutator: "noop", args: {}, createdAt: 0 };
      yield* store.appendNext(draft);
      state.failCounters = true;
      expect((yield* store.appendNext(draft)).mutationId).toBe(2);
      // The stored counter still says 1; the journal's own highest id wins, so
      // id 2 is not reissued over the live entry.
      expect((yield* store.appendNext(draft)).mutationId).toBe(3);
      expect((yield* store.pendingMutations).map((m) => m.mutationId)).toEqual([1, 2, 3]);
    })
  );

  it.effect("memory store: ids are consecutive per client", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const a = { clientId: "a", mutator: "noop", args: {}, createdAt: 0 };
      expect((yield* store.appendNext(a)).mutationId).toBe(1);
      expect((yield* store.appendNext({ ...a, clientId: "b" })).mutationId).toBe(1);
      expect((yield* store.appendNext(a)).mutationId).toBe(2);
    })
  );
});

/**
 * A KeyValueStore whose writes to the `counters` key can be made to fail, or
 * to park on a gate (to interrupt a fiber exactly between the index write and
 * the counter write).
 */
const controlledCounters = () => {
  const data = new Map<string, string>();
  const state: {
    failCounters: boolean;
    park: { reached: Deferred.Deferred<void>; gate: Deferred.Deferred<void> } | undefined;
  } = { failCounters: false, park: undefined };
  const kvs = KeyValueStore.makeStringOnly({
    get: (key) => Effect.sync(() => data.get(key)),
    set: (key, value) => {
      const write = Effect.sync(() => void data.set(key, value));
      if (!key.endsWith("counters")) return write;
      if (state.failCounters) {
        return Effect.fail(
          new KeyValueStore.KeyValueStoreError({ message: "injected", method: "set", key })
        );
      }
      const park = state.park;
      return park === undefined
        ? write
        : Deferred.succeed(park.reached, undefined).pipe(
            Effect.andThen(Deferred.await(park.gate)),
            Effect.andThen(write)
          );
    },
    remove: (key) => Effect.sync(() => void data.delete(key)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
  });
  return { kvs, state };
};

const draft = { clientId: "c1", mutator: "noop", args: {}, createdAt: 0 };

describe("an id that has left the journal is never reissued (#258 review)", () => {
  it.effect("counter write fails, entry acked, the next mutation is applied, not skipped", () =>
    Effect.gen(function* () {
      const { kvs, state } = controlledCounters();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      const { engine, applied } = yield* harness(store);
      state.failCounters = true;
      yield* engine.mutate("todo/set", { id: "a" }); // journaled; counter write swallowed
      state.failCounters = false;
      yield* engine.push; // server applies id 1, client acknowledges: journal empty
      yield* engine.mutate("todo/set", { id: "b" });
      expect(yield* ids(store)).toEqual([2]); // not 1: that id was already acknowledged
      yield* engine.push;
      expect(applied).toEqual(["a", "b"]);
    })
  );

  it.effect("interrupted between the index and counter writes, then acked: no reissue", () =>
    Effect.gen(function* () {
      const { kvs, state } = controlledCounters();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      const { engine, applied } = yield* harness(store);
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      state.park = { reached, gate };
      const fiber = yield* Effect.forkChild(engine.mutate("todo/set", { id: "a" }));
      yield* Deferred.await(reached);
      // The append is uninterruptible: the interrupt is only delivered once
      // the counter write has landed, so the journal and counter agree.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      // Let the interrupt be requested while the counter write is still parked.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(interrupting);
      state.park = undefined;
      yield* engine.push;
      yield* engine.mutate("todo/set", { id: "b" });
      expect(yield* ids(store)).toEqual([2]);
      yield* engine.push;
      expect(applied).toEqual(["a", "b"]);
    })
  );

  it.effect("acknowledge alone raises the counter past the ids it removes", () =>
    Effect.gen(function* () {
      const { kvs, state } = controlledCounters();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      state.failCounters = true;
      yield* store.appendNext(draft);
      yield* store.appendNext(draft);
      state.failCounters = false;
      yield* store.acknowledge("c1", 2);
      expect((yield* store.appendNext(draft)).mutationId).toBe(3);
    })
  );

  it.effect("an acknowledge whose counter write fails removes nothing", () =>
    Effect.gen(function* () {
      const { kvs, state } = controlledCounters();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      state.failCounters = true;
      yield* store.appendNext(draft);
      const failed = yield* Effect.flip(store.acknowledge("c1", 1));
      expect(failed._tag).toBe("StoreError");
      expect(yield* ids(store)).toEqual([1]);
    })
  );

  it.effect("quarantinePending keeps its ids reserved (key-value)", () =>
    Effect.gen(function* () {
      const { kvs, state } = controlledCounters();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kvs)
      );
      state.failCounters = true;
      yield* store.appendNext(draft);
      yield* store.appendNext(draft);
      state.failCounters = false;
      const fingerprint: Identity.Fingerprint = "sha256:alice";
      expect(yield* store.quarantinePending(fingerprint)).toBe(2);
      expect((yield* store.appendNext(draft)).mutationId).toBe(3);
    })
  );

  for (const [name, makeStore] of [
    ["memory", ClientStoreModule.makeMemory],
    ["key-value", ClientStoreModule.makeKeyValue()],
  ] as const) {
    it.effect(`heals the counter from journal entries it did not allocate (${name})`, () =>
      Effect.gen(function* () {
        const store = yield* makeStore;
        yield* store.appendMutation({ ...draft, mutationId: 5 });
        expect((yield* store.appendNext(draft)).mutationId).toBe(6);
        yield* store.acknowledge("c1", 6);
        expect((yield* store.appendNext(draft)).mutationId).toBe(7);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(
      `acknowledge and quarantine leave the next id above everything removed (${name})`,
      () =>
        Effect.gen(function* () {
          const store = yield* makeStore;
          yield* store.appendMutation({ ...draft, mutationId: 3 });
          yield* store.acknowledge("c1", 3);
          expect((yield* store.appendNext(draft)).mutationId).toBe(4);
          const fingerprint: Identity.Fingerprint = "sha256:bob";
          yield* store.quarantinePending(fingerprint);
          expect((yield* store.appendNext(draft)).mutationId).toBe(5);
        }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );
  }

  it.effect("memory store: appendNext is atomic with respect to compactPending", () =>
    Effect.gen(function* () {
      for (let round = 0; round < 20; round++) {
        const store = yield* ClientStoreModule.makeMemory;
        for (let i = 0; i < 3; i++) yield* store.appendNext(draft);
        yield* Effect.all(
          [store.compactPending("c1", [2]), store.appendNext(draft), store.appendNext(draft)],
          { concurrency: "unbounded" }
        );
        const after = yield* ids(store);
        // Consecutive from 1, whichever order the operations were served in,
        // and the counter agrees with the journal.
        expect(after).toEqual(after.map((_, i) => i + 1));
        expect((yield* store.appendNext(draft)).mutationId).toBe(after.length + 1);
      }
    })
  );
});
