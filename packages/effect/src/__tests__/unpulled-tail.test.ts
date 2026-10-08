/**
 * The acknowledged-but-unpulled tail, durable in `ClientStore` (#336). A
 * restart between a push acknowledgement and the next pull keeps the
 * mutation's effect overlaid; the pull that reports it releases the tail from
 * the store; an identity reset clears it; hydration carries it. The crash
 * windows are exercised by failing the store at each step and reopening it.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { StoreError } from "../Errors.js";
import * as Hydration from "../Hydration.js";
import * as Identity from "../Identity.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

interface Counter {
  readonly id: string;
  readonly n: number;
}

// A non-idempotent counter: a double application shows as an extra count.
const incrementCounter = <E>(
  writer: {
    readonly get: (collection: string, id: string) => Effect.Effect<unknown, E>;
    readonly put: (collection: string, id: string, value: unknown) => Effect.Effect<void, E>;
  },
  id: string
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const current = (yield* writer.get("counters", id)) as Counter | undefined;
    yield* writer.put("counters", id, { id, n: (current?.n ?? 0) + 1 });
  });

const counterMutators = Mutator.registry([
  {
    mutator: Mutator.make("counter/inc", Schema.Unknown),
    local: (args, writer) => incrementCounter(writer, (args as { readonly id: string }).id),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "counter/inc": (args, writer) => incrementCounter(writer, (args as { readonly id: string }).id),
};

const authPolicy = Authorization.policy({ counters: Authorization.allowAll });
const countersSubset = Subset.make({ collection: "counters" });

const serverOver = (backend: Backend) =>
  Effect.gen(function* () {
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, authPolicy),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
  });

// The counter client "client-a" in group "group-a", over `handler` and `store`.
const makeCounterEngine = (handler: Parameters<typeof makeInMemory>[0], store: ClientStore) =>
  Effect.gen(function* () {
    const transport = yield* makeInMemory(handler, "group-a");
    return yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: counterMutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const counterValue = (engine: ClientEngineModule.ClientEngine) =>
  engine
    .query(countersSubset)
    .pipe(
      Effect.map((rows) => (rows.find((row) => row.id === "c")?.value as Counter | undefined)?.n)
    );

/** The tail's entries as `client#id`, in tail order. */
const tailOf = (store: ClientStore) =>
  store.unpulled.pipe(Effect.map((entries) => entries.map((m) => `${m.clientId}#${m.mutationId}`)));

const mutation = (clientId: string, mutationId: number): Mutation => ({
  clientId,
  mutationId,
  mutator: "counter/inc",
  args: { id: "c" },
  createdAt: 0,
});

// The same contract over both implementations: the memory store and the
// key-value store over an in-memory KeyValueStore.
const stores = [
  ["memory", ClientStoreModule.makeMemory],
  ["key-value", ClientStoreModule.makeKeyValue()],
] as const;

describe("ClientStore's unpulled tail (#336)", () => {
  for (const [name, open] of stores) {
    it.effect(`${name}: parked entries leave the journal and stay readable in order`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.appendMutation(mutation("c1", 1));
        yield* store.appendMutation(mutation("c1", 2));
        yield* store.parkUnpulled([mutation("c1", 1)]);
        yield* store.acknowledge("c1", 1);
        expect(yield* tailOf(store)).toEqual(["c1#1"]);
        expect((yield* store.pendingMutations).map((m) => m.mutationId)).toEqual([2]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: parking the same entry twice keeps one copy`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.parkUnpulled([mutation("c1", 1)]);
        yield* store.parkUnpulled([mutation("c1", 1), mutation("c1", 2)]);
        expect(yield* tailOf(store)).toEqual(["c1#1", "c1#2"]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: a release removes exactly the entries its watermark covers`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.parkUnpulled([mutation("c1", 1), mutation("c2", 1), mutation("c1", 2)]);
        yield* store.releaseUnpulled({ c1: 1 });
        expect(yield* tailOf(store)).toEqual(["c2#1", "c1#2"]);
        yield* store.releaseUnpulled({ c1: 2, c2: 1 });
        expect(yield* store.unpulled).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: clearUnpulled drops the whole tail`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.parkUnpulled([mutation("c1", 1)]);
        yield* store.clearUnpulled;
        expect(yield* store.unpulled).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );
  }

  it.effect("key-value: the tail survives reopening the store over the same KeyValueStore", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.appendMutation(mutation("c1", 1));
      yield* first.parkUnpulled([mutation("c1", 1)]);
      yield* first.acknowledge("c1", 1);

      const second = yield* ClientStoreModule.makeKeyValue();
      expect(yield* second.pendingMutations).toEqual([]);
      expect(yield* tailOf(second)).toEqual(["c1#1"]);
      // The parked id stays reserved: the next mutation continues past it.
      expect(yield* second.nextMutationId("c1")).toBe(2);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a park that crashed before its index write is not visible", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.appendMutation(mutation("c1", 1));
      // The body landed; the index write never did.
      yield* kv.set("legation/unpulled/c1/1", JSON.stringify(mutation("c1", 1)));

      const second = yield* ClientStoreModule.makeKeyValue();
      expect(yield* second.unpulled).toEqual([]);
      expect((yield* second.pendingMutations).map((m) => m.mutationId)).toEqual([1]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a park that crashed before the journal trim is resolved to the tail", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.appendMutation(mutation("c1", 1));
      yield* first.appendMutation(mutation("c1", 2));
      yield* first.parkUnpulled([mutation("c1", 1)]);
      // Crash here: the journal still holds entry 1.

      const second = yield* ClientStoreModule.makeKeyValue();
      expect(yield* tailOf(second)).toEqual(["c1#1"]);
      // Entry 1 is in the tail alone: it is not pushed again, and not replayed twice.
      expect((yield* second.pendingMutations).map((m) => m.mutationId)).toEqual([2]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a pull release that crashed is finished on the next open", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.appendMutation(mutation("c1", 1));
      yield* first.parkUnpulled([mutation("c1", 1)]);
      yield* first.acknowledge("c1", 1);
      yield* first.parkUnpulled([mutation("c1", 2)]);
      yield* first.beginRelease({ lastMutationIds: { c1: 1 }, patch: [] });
      // Crash here: the release marker is down, the tail still holds entry 1.
      expect(yield* kv.has("legation/releaseIntent")).toBe(true);

      const second = yield* ClientStoreModule.makeKeyValue();
      expect(yield* tailOf(second)).toEqual(["c1#2"]);
      expect(yield* kv.has("legation/releaseIntent")).toBe(false);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a completed release leaves no marker behind", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.parkUnpulled([mutation("c1", 1)]);
      yield* store.beginRelease({ lastMutationIds: { c1: 1 }, patch: [] });
      yield* store.releaseUnpulled({ c1: 1 });
      expect(yield* kv.has("legation/releaseIntent")).toBe(false);
      expect(yield* store.unpulled).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a corrupt tail index seals the store rather than serving half a tail", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set("legation/unpulledIndex", "}{ not json");
      const store = yield* ClientStoreModule.makeKeyValue();
      const error = yield* Effect.flip(store.getCookie);
      expect(error).toBeInstanceOf(StoreError);
      expect(error.message).toContain("sealed");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: an identity reset at open clears the tail with the rows", () =>
    Effect.gen(function* () {
      const alice = "sha256:alice" as Identity.Fingerprint;
      const bob = "sha256:bob" as Identity.Fingerprint;
      const first = yield* ClientStoreModule.makeKeyValue({ identity: alice });
      yield* first.parkUnpulled([mutation("c1", 1)]);

      const second = yield* ClientStoreModule.makeKeyValue({ identity: bob });
      expect(yield* second.unpulled).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("the tail in an engine (#336)", () => {
  it.effect("a restart between a push acknowledgement and the next pull keeps the effect", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const first = yield* makeCounterEngine(server, store);
      yield* first.subscribe(countersSubset);
      yield* first.mutate("counter/inc", { id: "c" });
      yield* first.push;
      expect(yield* tailOf(store)).toEqual(["client-a#1"]);

      // The restart: a new engine over the same store, before any pull.
      const restarted = yield* makeCounterEngine(server, store);
      yield* restarted.subscribe(countersSubset);
      expect(yield* counterValue(restarted)).toBe(1);

      // Nothing is pushed again, and the pull that reports it releases the tail.
      yield* restarted.push;
      expect(yield* store.pendingMutations).toEqual([]);
      yield* restarted.pull;
      expect(yield* tailOf(store)).toEqual([]);
      expect(yield* counterValue(restarted)).toBe(1);
    })
  );

  it.effect(
    "the same restart over a durable store keeps the effect, and the pull releases it",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const first = yield* makeCounterEngine(server, yield* ClientStoreModule.makeKeyValue());
        yield* first.subscribe(countersSubset);
        yield* first.mutate("counter/inc", { id: "c" });
        yield* first.push;

        const reopened = yield* ClientStoreModule.makeKeyValue();
        const restarted = yield* makeCounterEngine(server, reopened);
        yield* restarted.subscribe(countersSubset);
        expect(yield* counterValue(restarted)).toBe(1);
        yield* restarted.pull;
        expect(yield* tailOf(reopened)).toEqual([]);
        expect(yield* counterValue(restarted)).toBe(1);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a pull that crashed after writing its rows is finished on the next open", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeKeyValue();
      // The pull's release fails once, as a crash would leave it: rows written, tail not released.
      const crashNext = yield* Ref.make(false);
      const store: ClientStore = {
        ...inner,
        releaseUnpulled: (lastMutationIds) =>
          Ref.getAndSet(crashNext, false).pipe(
            Effect.flatMap((crash) =>
              crash
                ? Effect.fail(new StoreError({ message: "crashed mid-release" }))
                : inner.releaseUnpulled(lastMutationIds)
            )
          ),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;

      yield* Ref.set(crashNext, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

      // Reopen: the release is finished, so the effect is counted once.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      const restarted = yield* makeCounterEngine(server, reopened);
      yield* restarted.subscribe(countersSubset);
      expect(yield* counterValue(restarted)).toBe(1);
      expect(yield* tailOf(reopened)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a push that crashed between parking and trimming is counted once, not re-pushed", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeKeyValue();
      // The journal trim fails once, as a crash after the park would leave it.
      const crashNext = yield* Ref.make(false);
      const store: ClientStore = {
        ...inner,
        acknowledge: (clientId, upTo) =>
          Ref.getAndSet(crashNext, false).pipe(
            Effect.flatMap((crash) =>
              crash
                ? Effect.fail(new StoreError({ message: "crashed mid-trim" }))
                : inner.acknowledge(clientId, upTo)
            )
          ),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* Ref.set(crashNext, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);

      // Reopen: the entry is in the tail, so it leaves the journal and is not pushed again.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* tailOf(reopened)).toEqual(["client-a#1"]);
      expect(yield* reopened.pendingMutations).toEqual([]);
      const restarted = yield* makeCounterEngine(server, reopened);
      yield* restarted.subscribe(countersSubset);
      yield* restarted.push;
      expect(yield* counterValue(restarted)).toBe(1);
      yield* restarted.pull;
      expect(yield* counterValue(restarted)).toBe(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a push whose park fails keeps the entry in the journal, so it is counted once", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeKeyValue();
      // The park fails once, before anything is trimmed.
      const crashNext = yield* Ref.make(false);
      const store: ClientStore = {
        ...inner,
        parkUnpulled: (mutations) =>
          Ref.getAndSet(crashNext, false).pipe(
            Effect.flatMap((crash) =>
              crash
                ? Effect.fail(new StoreError({ message: "park refused" }))
                : inner.parkUnpulled(mutations)
            )
          ),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* Ref.set(crashNext, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      // Nothing was trimmed: the entry is still pending, and nothing is parked.
      expect((yield* inner.pendingMutations).map((m) => m.mutationId)).toEqual([1]);
      expect(yield* tailOf(inner)).toEqual([]);

      const reopened = yield* ClientStoreModule.makeKeyValue();
      const restarted = yield* makeCounterEngine(server, reopened);
      yield* restarted.subscribe(countersSubset);
      yield* restarted.push;
      expect(yield* tailOf(reopened)).toEqual(["client-a#1"]);
      expect(yield* counterValue(restarted)).toBe(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a pull releases the tail from the store, not only from the engine", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 3; i++) yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      expect(yield* tailOf(store)).toEqual(["client-a#1", "client-a#2", "client-a#3"]);
      yield* engine.pull;
      expect(yield* store.unpulled).toEqual([]);
      expect(yield* counterValue(engine)).toBe(3);
    })
  );

  it.effect("the bound applies to the store as well as the engine's copy", () =>
    Effect.gen(function* () {
      const count = 1100;
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < count; i++) yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      const stored = yield* store.unpulled;
      expect(stored.length).toBe(1024);
      expect(stored.at(-1)?.mutationId).toBe(count);
    })
  );

  it.effect("an identity reset clears the stored tail along with the rows", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      expect(yield* tailOf(store)).toHaveLength(1);

      yield* engine.reset("sha256:another-subject" as Identity.Fingerprint);
      expect(yield* store.unpulled).toEqual([]);
      const restarted = yield* makeCounterEngine(server, store);
      yield* restarted.subscribe(countersSubset);
      expect(yield* counterValue(restarted)).toBeUndefined();
    })
  );

  it.effect("hydration carries the tail: a snapshot restores the overlay in a new store", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const source = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeCounterEngine(server, source);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;

      const wire = JSON.stringify(yield* Hydration.dehydrate(source));
      const target = yield* ClientStoreModule.makeMemory;
      yield* Hydration.hydrate(target, JSON.parse(wire));
      expect(yield* tailOf(target)).toEqual(["client-a#1"]);

      const restarted = yield* makeCounterEngine(server, target);
      yield* restarted.subscribe(countersSubset);
      expect(yield* counterValue(restarted)).toBe(1);
    })
  );

  it.effect("a snapshot without the tail field loads, with an empty tail", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const legacy = JSON.parse(JSON.stringify({ rows: [], journal: [] }));
      yield* Hydration.hydrate(store, legacy);
      expect(yield* store.unpulled).toEqual([]);
      const dehydrated = yield* Hydration.dehydrate(store);
      expect("unpulled" in dehydrated).toBe(false);
    })
  );
});

describe("the tail's crash windows and interleavings (#387)", () => {
  it.effect("an overflow release that fails keeps the copy and the store agreeing", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeMemory;
      // The first release refused, as a store error would: the tail is parked and acknowledged.
      const refuseNext = yield* Ref.make(true);
      const store: ClientStore = {
        ...inner,
        releaseUnpulled: (lastMutationIds) =>
          Ref.getAndSet(refuseNext, false).pipe(
            Effect.flatMap((refuse) =>
              refuse
                ? Effect.fail(new StoreError({ message: "release refused" }))
                : inner.releaseUnpulled(lastMutationIds)
            )
          ),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      // One more than the bound, so the push's park overflows and releases the oldest entry.
      for (let i = 0; i < 1025; i++) yield* engine.mutate("counter/inc", { id: "c" });
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      expect(yield* inner.unpulled).toHaveLength(1025);

      // A forced overlay rebuild reads the copy: it must still hold every entry the store holds.
      yield* engine.seed([]);
      expect(yield* counterValue(engine)).toBe(1025);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a boot read of the tail that fails is repaired by the next push", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const first = yield* makeCounterEngine(server, store);
      yield* first.subscribe(countersSubset);
      yield* first.mutate("counter/inc", { id: "c" });
      yield* first.push;
      expect(yield* tailOf(store)).toEqual(["client-a#1"]);

      // The second session's first read of the tail fails, at boot.
      const failNext = yield* Ref.make(true);
      const flaky: ClientStore = {
        ...store,
        unpulled: Effect.suspend(() => Ref.getAndSet(failNext, false)).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(new StoreError({ message: "unpulled read refused" }))
              : store.unpulled
          )
        ),
      };
      const second = yield* makeCounterEngine(server, flaky);
      yield* second.subscribe(countersSubset);
      yield* second.mutate("counter/inc", { id: "c" });
      yield* second.push;

      // The push must not write back a copy that dropped the stored entry.
      expect(yield* tailOf(store)).toEqual(["client-a#1", "client-a#2"]);
      expect(yield* counterValue(second)).toBe(2);
    })
  );

  it.effect(
    "a crash between a pull's release marker and its first row write keeps the effect",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const inner = yield* ClientStoreModule.makeKeyValue();
        // The pull's first row write fails: the marker is down, no row has changed.
        const crashNext = yield* Ref.make(false);
        const store: ClientStore = {
          ...inner,
          applyRowOps: (ops) =>
            Ref.getAndSet(crashNext, false).pipe(
              Effect.flatMap((crash) =>
                crash
                  ? Effect.fail(new StoreError({ message: "crashed before the first row write" }))
                  : inner.applyRowOps(ops)
              )
            ),
        };
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);
        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.push;

        yield* Ref.set(crashNext, true);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        // Reopen before any pull: the open finishes the pull, so the effect is still shown.
        const reopened = yield* ClientStoreModule.makeKeyValue();
        const restarted = yield* makeCounterEngine(server, reopened);
        yield* restarted.subscribe(countersSubset);
        expect(yield* counterValue(restarted)).toBe(1);
        expect(yield* tailOf(reopened)).toEqual([]);
        yield* restarted.pull;
        expect(yield* counterValue(restarted)).toBe(1);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a pull that interleaves with a push's park waits for the push's store writes", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeMemory;
      // The push parks its entry, then stops until the test resumes it: the window before its trim.
      const holdNext = yield* Ref.make(false);
      const parked = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const store: ClientStore = {
        ...inner,
        parkUnpulled: (mutations) =>
          Ref.getAndSet(holdNext, false).pipe(
            Effect.flatMap((hold) =>
              hold
                ? inner
                    .parkUnpulled(mutations)
                    .pipe(
                      Effect.andThen(Deferred.succeed(parked, undefined)),
                      Effect.andThen(Deferred.await(resume))
                    )
                : inner.parkUnpulled(mutations)
            )
          ),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* Ref.set(holdNext, true);
      const pushing = yield* Effect.forkChild(engine.push);
      yield* Deferred.await(parked);

      // A pull started now must wait for the push. Yielding lets it run as far as it can:
      // without the lock it would release the entry and the push would re-add it.
      const pulling = yield* Effect.forkChild(engine.pull);
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(pushing);
      yield* Fiber.join(pulling);

      expect(yield* counterValue(engine)).toBe(1);
      expect(yield* tailOf(inner)).toEqual([]);
      expect(yield* inner.pendingMutations).toEqual([]);
    })
  );

  it.effect("a snapshot taken across a push's acknowledgement does not count the entry twice", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const source = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeCounterEngine(server, source);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      const entry = (yield* source.pendingMutations)[0] as Mutation;

      // The acknowledgement lands between dehydrate's journal read and its tail read.
      const acked = yield* Ref.make(false);
      const racing: ClientStore = {
        ...source,
        unpulled: Effect.suspend(() => Ref.getAndSet(acked, true)).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : source
                  .parkUnpulled([entry])
                  .pipe(Effect.andThen(source.acknowledge(entry.clientId, entry.mutationId)))
          ),
          Effect.andThen(source.unpulled)
        ),
      };
      const snapshot = yield* Hydration.dehydrate(racing);
      expect(snapshot.journal).toHaveLength(1);
      expect(snapshot.unpulled).toHaveLength(1);

      const target = yield* ClientStoreModule.makeMemory;
      yield* Hydration.hydrate(target, JSON.parse(JSON.stringify(snapshot)));
      expect(yield* target.pendingMutations).toEqual([]);
      expect(yield* tailOf(target)).toEqual(["client-a#1"]);
    })
  );

  it.effect("key-value: a release whose body removal fails is finished on the next open", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      // The second body's removal fails, after the first body has gone.
      const faulty = KeyValueStore.KeyValueStore.of({
        ...kv,
        remove: (key) =>
          key === "legation/unpulled/c1/2"
            ? Effect.fail(
                new KeyValueStore.KeyValueStoreError({
                  message: "refused",
                  method: "remove",
                  key,
                })
              )
            : kv.remove(key),
      });
      const first = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, faulty)
      );
      yield* first.parkUnpulled([mutation("c1", 1), mutation("c1", 2)]);
      yield* first.beginRelease({ lastMutationIds: { c1: 2 }, patch: [] });
      expect(Exit.isFailure(yield* Effect.exit(first.releaseUnpulled({ c1: 2 })))).toBe(true);

      // Reopen over the healthy store: the release is finished, and no body is left behind.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* reopened.unpulled).toEqual([]);
      expect(yield* kv.has("legation/unpulled/c1/1")).toBe(false);
      expect(yield* kv.has("legation/unpulled/c1/2")).toBe(false);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});
