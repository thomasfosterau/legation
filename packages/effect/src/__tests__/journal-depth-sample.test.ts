/**
 * Sampling the journal-depth gauge must not read the journal.
 *
 * The engine samples `legation_journal_depth` on every append, acknowledgement
 * and paced compaction. It used to take `pendingMutations.length`, which on the
 * key-value store reads the index **and every pending body**, so a paced burst
 * against a long journal did O(n) body reads per call. `ClientStore.pendingCount`
 * counts from the index alone. These tests count the reads a KeyValueStore
 * serves and assert that no `journal/*` body is read by a sample.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import * as Json from "../internal/Json.js";
import { ClientGroupId, MutationId, RowId } from "../Protocol.js";

const todoSet = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));
const allTodos = Subset.make({ collection: "todos" });

/** A KeyValueStore that records every key it is asked to read. */
const countingKv = () => {
  const data = MutableHashMap.empty<string, string>();
  const reads: Array<string> = [];
  const store = KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.sync(() => {
        reads.push(key);
        return Option.getOrUndefined(MutableHashMap.get(data, key));
      }),
    set: (key, value) => Effect.sync(() => void MutableHashMap.set(data, key, value)),
    remove: (key) => Effect.sync(() => void MutableHashMap.remove(data, key)),
    clear: Effect.sync(() => MutableHashMap.clear(data)),
    size: Effect.sync(() => MutableHashMap.size(data)),
    keys: Effect.sync(() => [...MutableHashMap.keys(data)]),
  });
  /** How many reads of a journal body (`legation/journal/{client}/{id}`) were served. */
  const bodyReads = () => reads.filter((key) => key.startsWith("legation/journal/")).length;
  return { store, data, reads, bodyReads };
};

const journalDepth = Metric.value(Telemetry.journalDepth).pipe(Effect.map((s) => s.value));

/** An engine over a key-value `ClientStore` whose KVS counts its reads. */
const harness = Effect.fn("harness")(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) =>
        writer.put("todos", RowId.make(args.id), args)
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
  const kv = countingKv();
  const store = yield* ClientStoreModule.makeKeyValue().pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
  );
  const transport = yield* makeInMemory(handler, ClientGroupId.make("group-depth"));
  const engine = yield* ClientEngineModule.make({
    clientId: "client-depth",
    clientGroupId: ClientGroupId.make("group-depth"),
    mutators: Mutator.registry([
      {
        mutator: todoSet,
        local: (args: { id: string }, writer) => writer.put("todos", RowId.make(args.id), args),
      },
    ]),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );
  return { engine, store, kv };
});

describe("journal-depth sampling reads no journal bodies", () => {
  it.effect("a mutate against a long journal reads no pending body", () =>
    Effect.gen(function* () {
      const { engine, store, kv } = yield* harness();
      yield* Effect.forEach(Arr.range(1, 50), (n) => engine.mutate("todo/set", { id: `t${n}` }), {
        concurrency: 1,
        discard: true,
      });
      // The overlay cache is warm: the mutate path tracks onto it, so neither
      // the gauge sample nor the tracked-write fallback needs the journal.
      yield* engine.query(allTodos);

      kv.reads.length = 0;
      yield* engine.mutate("todo/set", { id: "t51" });
      expect(kv.bodyReads()).toBe(0);
      expect(yield* journalDepth).toBe(51);
      expect(yield* store.pendingCount).toBe(51);
    })
  );

  it.effect("a paced compaction of the tail reads no pending body", () =>
    Effect.gen(function* () {
      const { engine, store, kv } = yield* harness();
      yield* Effect.forEach(Arr.range(1, 50), (n) => engine.mutate("todo/set", { id: `t${n}` }), {
        concurrency: 1,
        discard: true,
      });

      // The usual paced shape: the superseded entry is the newest one, so the
      // compaction moves nothing and the sample after it counts.
      kv.reads.length = 0;
      const compaction = yield* engine.dropIfPending([50]);
      expect(compaction.dropped).toEqual([50]);
      expect(kv.bodyReads()).toBe(0);
      expect(yield* journalDepth).toBe(49);
      expect(yield* store.pendingCount).toBe(49);
    })
  );
});

const entry = (mutationId: number, clientId = "c1"): Mutation => ({
  clientId,
  mutationId: MutationId.make(mutationId),
  mutator: "noop",
  args: { n: mutationId },
  createdAt: 0,
});

describe("ClientStore.pendingCount", () => {
  it.effect("the key-value store counts the index, reading no body", () =>
    Effect.gen(function* () {
      const kv = countingKv();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
      );
      expect(yield* store.pendingCount).toBe(0);
      yield* Effect.forEach(Arr.range(1, 20), (n) => store.appendMutation(entry(n)), {
        concurrency: 1,
        discard: true,
      });
      yield* store.appendMutation(entry(1, "c2"));

      kv.reads.length = 0;
      expect(yield* store.pendingCount).toBe(21);
      expect(kv.bodyReads()).toBe(0);

      yield* store.acknowledge("c1", 5);
      expect(yield* store.pendingCount).toBe(16);
      expect(yield* store.pendingCount).toBe((yield* store.pendingMutations).length);
    })
  );

  it.effect("the key-value store counts a legacy whole-journal blob", () =>
    Effect.gen(function* () {
      const kv = countingKv();
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kv.store)
      );
      // A store written before the journal was split into per-entry bodies.
      yield* Effect.sync(() => {
        MutableHashMap.remove(kv.data, "legation/journalIndex");
        MutableHashMap.set(
          kv.data,
          "legation/journal",
          Json.stringify([entry(1), entry(2), entry(3)])
        );
      });
      expect(yield* store.pendingCount).toBe(3);
      expect((yield* store.pendingMutations).length).toBe(3);
    })
  );

  it.effect("the memory store counts its journal", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      expect(yield* store.pendingCount).toBe(0);
      yield* store.appendMutation(entry(1));
      yield* store.appendNext({ clientId: "c1", mutator: "noop", args: {}, createdAt: 0 });
      expect(yield* store.pendingCount).toBe(2);
      yield* store.acknowledge("c1", 1);
      expect(yield* store.pendingCount).toBe(1);
    })
  );
});
