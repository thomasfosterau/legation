/**
 * The acknowledged-but-unpulled tail, durable in `ClientStore` (#336). A
 * restart between a push acknowledgement and the next pull keeps the
 * mutation's effect overlaid; the pull that reports it releases the tail from
 * the store; an identity reset clears it; hydration carries it. The crash
 * windows are exercised by failing the store at each step and reopening it.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { StoreError, TransportError, VersionNotSupportedError } from "../Errors.js";
import * as Hydration from "../Hydration.js";
import * as Identity from "../Identity.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import { defined } from "./defined.js";

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

// The bound the tests that push past it run with. The default bound (1024) is left to the one test
// that checks it.
const SMALL_LIMIT = 8;

const serverOver = (backend: Backend) =>
  Effect.gen(function* () {
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, authPolicy),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
  });

// A transport whose pulls are refused while `refusing` is set. The refusal is a version rejection, which
// the engine does not retry, so it is immediate. Pushes are not affected.
const refusingPulls = (inner: ClientTransport, refusing: Ref.Ref<boolean>): ClientTransport => ({
  ...inner,
  pull: (request) =>
    Ref.get(refusing).pipe(
      Effect.flatMap((on) =>
        on
          ? Effect.fail(new VersionNotSupportedError({ message: "pulls refused by the test" }))
          : inner.pull(request)
      )
    ),
});

// The counter client "client-a" in group "group-a", over `handler` and `store`. `unpulledLimit`
// lowers the bound, so a test pushes a few mutations past it instead of a thousand.
// `refusing` makes the engine's pulls refusable (see `refusingPulls`).
const makeCounterEngine = (
  handler: Parameters<typeof makeInMemory>[0],
  store: ClientStore,
  unpulledLimit?: number,
  refusing?: Ref.Ref<boolean>
) =>
  Effect.gen(function* () {
    const inner = yield* makeInMemory(handler, "group-a");
    const transport = refusing === undefined ? inner : refusingPulls(inner, refusing);
    return yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: counterMutators,
      ...(unpulledLimit === undefined ? {} : { unpulledLimit }),
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

// The writes a `flakyKeyValue` refuses: the keys, whether each refusal is the next write only, and
// whether a refused write lands before it reports failure (an ambiguous abort).
interface Refusal {
  readonly keys: ReadonlySet<string>;
  readonly once: boolean;
  readonly landed: boolean;
}
const refuse = (
  refused: Ref.Ref<Refusal>,
  keys: ReadonlyArray<string>,
  once: boolean,
  landed = false
) => Ref.set(refused, { keys: new Set(keys), once, landed });

// Whether the next operation on `key` is refused, and whether a refused write lands anyway. A refusal
// names the key once when `once` is set.
const nextRefusal = (refused: Ref.Ref<Refusal>, key: string) =>
  Ref.modify(refused, (current) => {
    if (!current.keys.has(key)) return [{ refused: false, landed: false }, current] as const;
    const outcome = { refused: true, landed: current.landed };
    if (!current.once) return [outcome, current] as const;
    const keys = new Set(current.keys);
    keys.delete(key);
    return [outcome, { ...current, keys }] as const;
  });

// A KeyValueStore whose writes to the refused keys fail, as a store error would: once per key, or
// on every write until the test clears the refusals. `removals` refuses removals the same way.
const flakyKeyValue = (refused: Ref.Ref<Refusal>, removals: Ref.Ref<Refusal>) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    return {
      ...kv,
      set: (key: string, value: string | Uint8Array) =>
        nextRefusal(refused, key).pipe(
          Effect.flatMap(({ refused: refusedWrite, landed }) => {
            if (!refusedWrite) return kv.set(key, value);
            const failure = new KeyValueStore.KeyValueStoreError({
              message: "refused",
              method: "set",
              key,
            });
            return landed
              ? kv.set(key, value).pipe(Effect.andThen(Effect.fail(failure)))
              : Effect.fail(failure);
          })
        ),
      remove: (key: string) =>
        nextRefusal(removals, key).pipe(
          Effect.flatMap(({ refused: refusedRemoval }) =>
            refusedRemoval
              ? Effect.fail(
                  new KeyValueStore.KeyValueStoreError({
                    message: "refused",
                    method: "remove",
                    key,
                  })
                )
              : kv.remove(key)
          )
        ),
    } satisfies KeyValueStore.KeyValueStore;
  });

// A KeyValueStore whose first write to `key` blocks until the test releases it, then fails: the window
// in which another fiber can queue behind a failing write. Later writes to `key` pass through, so a
// write that runs after the failure is not refused for the gate's sake.
const gatedKeyValue = (
  key: string,
  reached: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const gate = yield* Ref.make(true);
    return {
      ...kv,
      set: (k: string, value: string | Uint8Array) =>
        k !== key
          ? kv.set(k, value)
          : Ref.getAndSet(gate, false).pipe(
              Effect.flatMap((first) =>
                first
                  ? Deferred.succeed(reached, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(
                        Effect.fail(
                          new KeyValueStore.KeyValueStoreError({
                            message: "refused",
                            method: "set",
                            key: k,
                          })
                        )
                      )
                    )
                  : kv.set(k, value)
              )
            ),
    } satisfies KeyValueStore.KeyValueStore;
  });

// The row `id`'s counter value, or `undefined` when the store holds no such row.
const rowCount = (store: ClientStore, id: string) =>
  store.getRow("counters", id).pipe(Effect.map((row) => (row?.value as Counter | undefined)?.n));

const putCounter = (store: ClientStore, id: string, n: number) =>
  store.putRow("counters", { id, version: 1, value: { id, n } });

const rowKeyOf = (id: string) => `legation/row/counters/${id}`;

// The counter client over a flaky store, after a first pull, with each of `ids` incremented once and
// pushed, so the next pull is a diff that writes all of them.
const counterSetUp = (ids: ReadonlyArray<string>, unpulledLimit?: number) =>
  Effect.gen(function* () {
    const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
    const refused = yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false });
    const removals = yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false });
    const flaky = yield* flakyKeyValue(refused, removals);
    const store = yield* ClientStoreModule.makeKeyValue().pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, flaky)
    );
    const pullsRefused = yield* Ref.make(false);
    const engine = yield* makeCounterEngine(server, store, unpulledLimit, pullsRefused);
    yield* engine.subscribe(countersSubset);
    yield* engine.pull;
    for (const id of ids) yield* engine.mutate("counter/inc", { id });
    yield* engine.push;
    return { server, refused, removals, store, engine, pullsRefused };
  });

// A KeyValueStore that counts the reads of `key`, and whose next read of it fails when `failNext` is
// set, once, as a transient store error would. Reads of other keys pass through.
const spyKeyValue = (key: string) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const reads = yield* Ref.make(0);
    const failNext = yield* Ref.make(false);
    const spy = {
      ...kv,
      get: (k: string) =>
        k !== key
          ? kv.get(k)
          : Ref.update(reads, (n) => n + 1).pipe(
              Effect.andThen(Ref.getAndSet(failNext, false)),
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new KeyValueStore.KeyValueStoreError({
                        message: "refused",
                        method: "get",
                        key: k,
                      })
                    )
                  : kv.get(k)
              )
            ),
    } satisfies KeyValueStore.KeyValueStore;
    return { spy, reads, failNext };
  });

// A KeyValueStore whose reads of the release record fail once, after `arm(n)` lets `n` of them pass.
// Reads of other keys pass through, and nothing fails until armed.
const failRecordRead = (base: KeyValueStore.KeyValueStore) =>
  Effect.gen(function* () {
    // `undefined` is disarmed; otherwise the reads that still pass before the next one fails.
    const passes = yield* Ref.make<number | undefined>(undefined);
    const kv: KeyValueStore.KeyValueStore = {
      ...base,
      get: (key: string) =>
        key !== "legation/releaseIntent"
          ? base.get(key)
          : Ref.modify(passes, (n): readonly [boolean, number | undefined] =>
              n === undefined ? [false, undefined] : n === 0 ? [true, undefined] : [false, n - 1]
            ).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new KeyValueStore.KeyValueStoreError({
                        message: "refused",
                        method: "get",
                        key,
                      })
                    )
                  : base.get(key)
              )
            ),
    } satisfies KeyValueStore.KeyValueStore;
    return { kv, arm: (n: number) => Ref.set(passes, n) };
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

    it.effect(`${name}: a second release finishes the outstanding one before it begins`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.parkUnpulled([mutation("c1", 1), mutation("c1", 2)]);
        yield* store.beginRelease({ lastMutationIds: { c1: 1 }, patch: [] });
        // The first release is finished, which releases c1#1, and the second is recorded in its place.
        yield* store.beginRelease({ lastMutationIds: { c1: 2 }, patch: [] });
        expect(yield* tailOf(store)).toEqual(["c1#2"]);
        yield* store.releaseUnpulled({ c1: 2 });
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

    it.effect(
      `${name}: a release that covers journal entries raises their counters, so no id is reused`,
      () =>
        Effect.gen(function* () {
          const store = yield* open;
          // Journaled directly, so nothing has raised the counter past them.
          yield* store.appendMutation(mutation("c1", 1));
          yield* store.appendMutation(mutation("c1", 2));
          yield* releaseCovering(store, { c1: 2 });
          expect(yield* store.pendingMutations).toEqual([]);
          expect(yield* store.nextMutationId("c1")).toBe(3);
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
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    it.effect(
      `an unpulledLimit that is not a positive integer is a defect when the engine is made (${limit})`,
      () =>
        Effect.gen(function* () {
          const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
          const store = yield* ClientStoreModule.makeMemory;
          const exit = yield* Effect.exit(makeCounterEngine(server, store, limit));
          expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
        }).pipe(Effect.scoped)
    );
  }

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

  it.effect("a stalled transport holds the stored tail at the bound, and the store agrees", () =>
    Effect.gen(function* () {
      const count = 1100;
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const refusing = yield* Ref.make(false);
      const engine = yield* makeCounterEngine(server, store, undefined, refusing);
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < count; i++) yield* engine.mutate("counter/inc", { id: "c" });
      // Pulls are refused. The first push sends the threshold (512) and then needs a pull, which fails. The
      // second fills the tail to the bound with its first chunk, and fails on the pull before the next one.
      yield* Ref.set(refusing, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      const stored = yield* store.unpulled;
      expect(stored.length).toBe(1024);
      expect(stored.at(-1)?.mutationId).toBe(1024);
      expect(yield* store.pendingMutations).toHaveLength(count - 1024);
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
      // The push's store write (the park and the trim, one batch) completes, then the push stops until
      // the test resumes it: the window in which the push still holds the overlay lock.
      const holdNext = yield* Ref.make(false);
      const parked = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const store: ClientStore = {
        ...inner,
        commitAcknowledgement: (parkedNow, lastMutationIds) =>
          Ref.getAndSet(holdNext, false).pipe(
            Effect.flatMap((hold) =>
              hold
                ? defined(inner.commitAcknowledgement)(parkedNow, lastMutationIds).pipe(
                    Effect.andThen(Deferred.succeed(parked, undefined)),
                    Effect.andThen(Deferred.await(resume))
                  )
                : defined(inner.commitAcknowledgement)(parkedNow, lastMutationIds)
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
      // The member-by-member path (a store without `snapshot`): the race is between its reads.
      const racing: ClientStore = {
        ...source,
        snapshot: undefined,
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

describe("a pull release that fails part-way (#387)", () => {
  it.effect(
    "a pull whose second row write fails, then a hydration, keeps the snapshot across a reopen",
    () =>
      Effect.gen(function* () {
        const { refused, store, engine } = yield* counterSetUp(["c", "d"]);
        yield* refuse(refused, [rowKeyOf("d")], true);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        // The snapshot sets `c` to 5 and says nothing about `d`.
        const source = yield* ClientStoreModule.makeMemory;
        yield* source.putRow("counters", { id: "c", version: 1, value: { id: "c", n: 5 } });
        yield* Hydration.hydrate(store, yield* Hydration.dehydrate(source));

        const reopened = yield* ClientStoreModule.makeKeyValue();
        expect(yield* rowCount(reopened, "c")).toBe(5);
        expect(yield* rowCount(reopened, "d")).toBe(1);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a pull whose roll-forward also fails seals the store until it is reopened", () =>
    Effect.gen(function* () {
      const { refused, store, engine } = yield* counterSetUp(["c", "d"]);
      // Every write of `d` fails, so the roll-forward fails too.
      yield* refuse(refused, [rowKeyOf("d")], false);
      expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

      // The store is sealed: reads and writes fail, and nothing runs over the outstanding release.
      expect(Exit.isFailure(yield* Effect.exit(store.getRow("counters", "c")))).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(store.parkUnpulled([mutation("client-a", 99)])))
      ).toBe(true);

      // Reopen once the writes succeed: the open finishes the release from its record.
      yield* refuse(refused, [], false);
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* rowCount(reopened, "c")).toBe(1);
      expect(yield* rowCount(reopened, "d")).toBe(1);
      expect(yield* tailOf(reopened)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a pull that fails on the last of three row writes is finished on reopen, every row written",
    () =>
      Effect.gen(function* () {
        const { refused, engine } = yield* counterSetUp(["c", "d", "e"]);
        // The third row fails for the rest of the session, as a crash would leave it.
        yield* refuse(refused, [rowKeyOf("e")], false);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);
        yield* refuse(refused, [], false);

        const reopened = yield* ClientStoreModule.makeKeyValue();
        expect(yield* rowCount(reopened, "c")).toBe(1);
        expect(yield* rowCount(reopened, "d")).toBe(1);
        expect(yield* rowCount(reopened, "e")).toBe(1);
        expect(yield* tailOf(reopened)).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a hydration finishes an outstanding release before it writes", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      // An outstanding release whose patch sets `c` to 1, and that has not finished.
      yield* first.beginRelease({
        lastMutationIds: {},
        cookie: "cookie-1",
        patch: [
          { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
        ],
      });
      const source = yield* ClientStoreModule.makeMemory;
      yield* source.putRow("counters", { id: "c", version: 2, value: { id: "c", n: 5 } });
      yield* Hydration.hydrate(first, yield* Hydration.dehydrate(source));

      // The release is not re-applied over the snapshot on the next open.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* rowCount(reopened, "c")).toBe(5);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: clearRows finishes an outstanding release before it clears the rows", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.beginRelease({
        lastMutationIds: {},
        patch: [
          { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
        ],
      });
      yield* first.clearRows;

      // The cleared rows stay cleared: the record did not re-apply its patch on the next open.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* rowCount(reopened, "c")).toBeUndefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

// A release that covers `lastMutationIds` and carries no rows: the atomic batch where the store has
// one (#411), else the record path it stands for.
const releaseCovering = (store: ClientStore, lastMutationIds: Readonly<Record<string, number>>) =>
  store.commitPull !== undefined
    ? store.commitPull({ lastMutationIds, patch: [] })
    : store.beginRelease({ lastMutationIds, patch: [] }).pipe(Effect.andThen(store.finishRelease));

// The release scenario of the two-store test: two parked entries, one of them covered by the release.
const releaseScenario = (store: ClientStore) =>
  Effect.gen(function* () {
    yield* store.appendMutation(mutation("c1", 1));
    yield* store.appendMutation(mutation("c1", 2));
    yield* store.appendMutation(mutation("c1", 3));
    yield* store.parkUnpulled([mutation("c1", 1), mutation("c1", 2)]);
    yield* store.beginRelease({
      lastMutationIds: { c1: 1 },
      cookie: "cookie-1",
      patch: [
        {
          _tag: "Put",
          collection: "counters",
          id: "c",
          version: 1,
          value: { id: "c", n: 1 },
        },
      ],
    });
    yield* store.finishRelease;
    return {
      row: yield* rowCount(store, "c"),
      cookie: yield* store.getCookie,
      tail: yield* tailOf(store),
      pending: (yield* store.pendingMutations).map((m) => `${m.clientId}#${m.mutationId}`),
    };
  });

// The release record's review follow-up (#387): the store-level guarantees, over both implementations
// where both can exhibit them.
describe("a release record's guarantees across both stores (#387 review)", () => {
  for (const [name, open] of stores) {
    it.effect(`${name}: clearUnpulled also ends a release in progress`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.beginRelease({ lastMutationIds: { c1: 1 }, patch: [] });
        yield* store.clearUnpulled;
        // The record went with the tail, so the next release may begin.
        yield* store.beginRelease({ lastMutationIds: {}, patch: [] });
        yield* store.releaseUnpulled({});
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: a finish drops the journal copy of a parked entry, as an open does`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.appendMutation(mutation("c1", 1));
        yield* store.appendMutation(mutation("c1", 2));
        // Parked, but its journal copy was not trimmed (a push whose acknowledgement stopped short).
        yield* store.parkUnpulled([mutation("c1", 1)]);
        yield* store.finishRelease;
        expect((yield* store.pendingMutations).map((m) => m.mutationId)).toEqual([2]);
        expect(yield* tailOf(store)).toEqual(["c1#1"]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: a row write finishes an outstanding release before it writes`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.beginRelease({
          lastMutationIds: {},
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        // The release's patch must not land over this write when the release finishes later.
        yield* putCounter(store, "c", 5);
        yield* store.finishRelease;
        expect(yield* rowCount(store, "c")).toBe(5);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: a row delete finishes an outstanding release before it deletes`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.beginRelease({
          lastMutationIds: {},
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        yield* store.delRow("counters", "c");
        yield* store.finishRelease;
        expect(yield* rowCount(store, "c")).toBeUndefined();
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: clearRows finishes an outstanding release before it clears the rows`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.beginRelease({
          lastMutationIds: {},
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        yield* store.clearRows;
        expect(yield* rowCount(store, "c")).toBeUndefined();
        // The record was finished, so there is nothing for a later finish to re-apply.
        yield* store.finishRelease;
        expect(yield* rowCount(store, "c")).toBeUndefined();
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: a hydration finishes an outstanding release before it writes`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.beginRelease({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        const source = yield* ClientStoreModule.makeMemory;
        yield* putCounter(source, "c", 5);
        yield* Hydration.hydrate(store, yield* Hydration.dehydrate(source));
        expect(yield* rowCount(store, "c")).toBe(5);
        // The release finished first, so its cookie is in place, and the snapshot did not revert it.
        expect(yield* store.getCookie).toBe("cookie-1");
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(
      `${name}: an append of an id the tail holds is refused, so no copy is journaled`,
      () =>
        Effect.gen(function* () {
          const store = yield* open;
          yield* store.parkUnpulled([mutation("c1", 1)]);
          expect(Exit.isFailure(yield* Effect.exit(store.appendMutation(mutation("c1", 1))))).toBe(
            true
          );
          expect(yield* store.pendingMutations).toEqual([]);
          expect(yield* tailOf(store)).toEqual(["c1#1"]);
        }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: hydrating a journal entry the tail holds does not journal it again`, () =>
      Effect.gen(function* () {
        const store = yield* open;
        yield* store.appendMutation(mutation("c1", 1));
        yield* store.parkUnpulled([mutation("c1", 1)]);
        yield* putCounter(store, "c", 1); // the row write settles the parked journal copy
        // A snapshot whose journal still holds the entry, as a dehydrate that races an acknowledgement gives.
        yield* Hydration.hydrate(
          store,
          JSON.parse(JSON.stringify({ rows: [], journal: [mutation("c1", 1)] }))
        );
        expect(yield* store.pendingMutations).toEqual([]);
        yield* putCounter(store, "c", 2);
        expect(yield* store.pendingMutations).toEqual([]);
        expect(yield* tailOf(store)).toEqual(["c1#1"]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    it.effect(`${name}: the two stores finish the same release to the same state`, () =>
      Effect.gen(function* () {
        const memory = yield* releaseScenario(yield* ClientStoreModule.makeMemory);
        const keyValue = yield* releaseScenario(yield* ClientStoreModule.makeKeyValue());
        expect(memory).toEqual({
          row: 1,
          cookie: "cookie-1",
          tail: ["c1#2"],
          pending: ["c1#3"],
        });
        expect(keyValue).toEqual(memory);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );
  }

  it.effect("key-value: a row write that finishes a release is the one an open leaves", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.beginRelease({
        lastMutationIds: {},
        cookie: "cookie-1",
        patch: [
          { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
        ],
      });
      yield* putCounter(first, "c", 5);
      // The release is finished by the write, so the next open does not re-apply its patch over it.
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect(yield* rowCount(reopened, "c")).toBe(5);
      expect(yield* reopened.getCookie).toBe("cookie-1");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "key-value: a write queued behind a failing finish is refused, not run over the record",
    () =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gated = yield* gatedKeyValue("legation/row/counters/c", reached, release);
        const store = yield* ClientStoreModule.makeKeyValue().pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, gated)
        );
        // A release whose patch sets `c`; its finish writes `c` and blocks there, then fails.
        yield* store.beginRelease({
          lastMutationIds: {},
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        const finishing = yield* Effect.forkChild(store.finishRelease);
        yield* Deferred.await(reached);
        // Queued behind the finish, before it fails. Once it fails the store is sealed, so this must not
        // write `d` over the outstanding record.
        const queued = yield* Effect.forkChild(putCounter(store, "d", 1));
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(finishing)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(queued)))).toBe(true);

        // Reopen: the record finishes as it would have, and the refused write is absent.
        const kv = yield* KeyValueStore.KeyValueStore;
        expect(yield* kv.has("legation/row/counters/d")).toBe(false);
        const reopened = yield* ClientStoreModule.makeKeyValue();
        expect(yield* rowCount(reopened, "c")).toBe(1);
        expect(yield* rowCount(reopened, "d")).toBeUndefined();
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("key-value: a park whose journal trim failed is settled by the in-process finish", () =>
    Effect.gen(function* () {
      const armed = yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false });
      const kv = yield* flakyKeyValue(
        yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false }),
        armed
      );
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, kv)
      );
      yield* store.appendMutation(mutation("c1", 1));
      yield* store.appendMutation(mutation("c1", 2));
      yield* store.parkUnpulled([mutation("c1", 1)]);
      // The acknowledgement's removal of entry 1's body is refused: the journal keeps its copy.
      yield* refuse(armed, ["legation/journal/c1/1"], true);
      expect(Exit.isFailure(yield* Effect.exit(store.acknowledge("c1", 1)))).toBe(true);
      yield* store.finishRelease;

      // The in-process finish leaves what an open would leave.
      expect((yield* store.pendingMutations).map((m) => m.mutationId)).toEqual([2]);
      const reopened = yield* ClientStoreModule.makeKeyValue();
      expect((yield* reopened.pendingMutations).map((m) => m.mutationId)).toEqual([2]);
      expect(yield* tailOf(reopened)).toEqual(["c1#1"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

// The same three steps through the atomic batch members (#411): the memory store takes them as the
// engine does on a store that has them. The record-path counterpart runs the same steps on the
// key-value store, which has no AtomicKeyValue here and so takes the record path.
const stateOf = (store: ClientStore) =>
  Effect.gen(function* () {
    return {
      row: yield* rowCount(store, "c"),
      cookie: yield* store.getCookie,
      tail: yield* tailOf(store),
      pending: (yield* store.pendingMutations).map((m) => `${m.clientId}#${m.mutationId}`),
    };
  });

const appendFour = (store: ClientStore) =>
  Effect.forEach(
    [mutation("c1", 1), mutation("c1", 2), mutation("c1", 3), mutation("c2", 1)],
    (m) => store.appendMutation(m),
    { discard: true }
  );

const batchMembersScenario = (store: ClientStore) =>
  Effect.gen(function* () {
    yield* appendFour(store);
    yield* defined(store.commitAcknowledgement)([mutation("c1", 1), mutation("c1", 2)], { c1: 1 });
    const afterAck = yield* stateOf(store);
    yield* defined(store.commitPull)({ lastMutationIds: { c1: 1 }, patch: [] });
    const afterRelease = yield* stateOf(store);
    yield* defined(store.commitPull)({
      lastMutationIds: { c1: 2 },
      cookie: "cookie-2",
      patch: [
        { _tag: "Put", collection: "counters", id: "c", version: 2, value: { id: "c", n: 2 } },
      ],
    });
    return {
      afterAck,
      afterRelease,
      final: yield* stateOf(store),
      nextId: yield* store.nextMutationId("c1"),
    };
  });

const recordMembersScenario = (store: ClientStore) =>
  Effect.gen(function* () {
    yield* appendFour(store);
    yield* store.parkUnpulled([mutation("c1", 1), mutation("c1", 2)]);
    yield* store.acknowledge("c1", 1);
    const afterAck = yield* stateOf(store);
    yield* store.beginRelease({ lastMutationIds: { c1: 1 }, patch: [] });
    yield* store.releaseUnpulled({ c1: 1 });
    const afterRelease = yield* stateOf(store);
    yield* store.beginRelease({
      lastMutationIds: { c1: 2 },
      cookie: "cookie-2",
      patch: [
        { _tag: "Put", collection: "counters", id: "c", version: 2, value: { id: "c", n: 2 } },
      ],
    });
    yield* store.finishRelease;
    return {
      afterAck,
      afterRelease,
      final: yield* stateOf(store),
      nextId: yield* store.nextMutationId("c1"),
    };
  });

describe("the memory store's atomic batch members (#411)", () => {
  it.effect("the batch members reach the state the key-value record path reaches", () =>
    Effect.gen(function* () {
      const batched = yield* batchMembersScenario(yield* ClientStoreModule.makeMemory);
      const recorded = yield* recordMembersScenario(yield* ClientStoreModule.makeKeyValue());
      expect(batched.afterAck).toEqual({
        row: undefined,
        cookie: undefined,
        tail: ["c1#1", "c1#2"],
        pending: ["c1#2", "c1#3", "c2#1"],
      });
      expect(batched.afterRelease.tail).toEqual(["c1#2"]);
      expect(batched.final).toEqual({
        row: 2,
        cookie: "cookie-2",
        tail: [],
        pending: ["c1#3", "c2#1"],
      });
      // The counters agree too: c1's next id continues after its highest journaled entry.
      expect(batched.nextId).toBe(4);
      expect(recorded).toEqual(batched);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a batch pull's commit after a begun release finishes the release first, then writes its own patch",
    () =>
      Effect.gen(function* () {
        const store = yield* ClientStoreModule.makeMemory;
        // A record whose patch sets `c` and `d`, begun but not finished.
        yield* store.beginRelease({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
            { _tag: "Put", collection: "counters", id: "d", version: 1, value: { id: "d", n: 1 } },
          ],
        });
        // The batch commit's own patch sets `c` to a later value and leaves `d` alone.
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-2",
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 2, value: { id: "c", n: 2 } },
          ],
        });
        // The record's `d` landed (it was finished first), and the commit's `c` came after it.
        expect(yield* rowCount(store, "c")).toBe(2);
        expect(yield* rowCount(store, "d")).toBe(1);
        expect(yield* store.getCookie).toBe("cookie-2");

        // Nothing is left to re-apply: a later finish does not put the record's values back.
        yield* store.finishRelease;
        expect(yield* rowCount(store, "c")).toBe(2);
        expect(yield* rowCount(store, "d")).toBe(1);
        expect(yield* store.getCookie).toBe("cookie-2");
      })
  );
});

// The engine's failure paths around the release record, and the locks its direct store writes take
// (#387 review).
describe("the engine's release failure paths (#387 review)", () => {
  it.effect(
    "a pull whose release record lands but reports failure is finished, so the next pull succeeds",
    () =>
      Effect.gen(function* () {
        const { refused, store, engine } = yield* counterSetUp(["c", "d"]);
        // The record is written, then its write reports failure, as an ambiguous abort does.
        yield* refuse(refused, ["legation/releaseIntent"], true, true);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        // The failed record was finished in this process, so the store is not wedged.
        yield* engine.pull;
        expect(yield* counterValue(engine)).toBe(1);
        expect(yield* rowCount(store, "c")).toBe(1);
        expect(yield* rowCount(store, "d")).toBe(1);
        expect(yield* tailOf(store)).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a pull whose cookie write fails is finished, so a reopen holds the pull's cookie",
    () =>
      Effect.gen(function* () {
        const { refused, store, engine } = yield* counterSetUp(["c", "d"]);
        const before = yield* store.getCookie;
        // The cookie write is the pull's only write after its rows and before its release.
        yield* refuse(refused, ["legation/cookie"], true);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        // The reopened store has the pull's cookie, not the one from before the pull.
        const reopened = yield* ClientStoreModule.makeKeyValue();
        const cookie = yield* reopened.getCookie;
        expect(cookie).toBeDefined();
        expect(cookie).not.toBe(before);
        expect(yield* tailOf(reopened)).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a pull whose roll-forward fails drops the cached overlay: the sealed engine fails",
    () =>
      Effect.gen(function* () {
        const { refused, engine } = yield* counterSetUp(["c", "d"]);
        // Warm the overlay cache with the view before the pull.
        expect(yield* counterValue(engine)).toBe(1);
        // Every write of `d` fails, so the roll-forward fails too and the store seals.
        yield* refuse(refused, [rowKeyOf("d")], false);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);
        // A cached view must not answer for a sealed store.
        expect(Exit.isFailure(yield* Effect.exit(counterValue(engine)))).toBe(true);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a pull whose roll-forward could not read its record is finished by the next pull, not refused",
    () =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const refused = yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false });
        const removals = yield* Ref.make<Refusal>({ keys: new Set(), once: false, landed: false });
        const { kv: reads, arm } = yield* failRecordRead(yield* flakyKeyValue(refused, removals));
        const store = yield* ClientStoreModule.makeKeyValue().pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, reads)
        );
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);
        yield* engine.pull;
        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.mutate("counter/inc", { id: "d" });
        yield* engine.push;

        // The pull's second row write fails. Its record read passes, and the roll-forward's read fails.
        yield* refuse(refused, [rowKeyOf("d")], true);
        yield* arm(1);
        expect(Exit.isFailure(yield* Effect.exit(engine.pull))).toBe(true);

        // The next pull finishes the outstanding record first, so it is not refused.
        yield* engine.pull;
        expect(yield* counterValue(engine)).toBe(1);
        expect(yield* rowCount(store, "d")).toBe(1);
        expect(yield* tailOf(store)).toEqual([]);
        const reopened = yield* ClientStoreModule.makeKeyValue().pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, kv)
        );
        expect(yield* rowCount(reopened, "d")).toBe(1);
        expect(yield* reopened.getCookie).toBeDefined();
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a push whose journal trim fails leaves no journal copy of the parked entry", () =>
    Effect.gen(function* () {
      const { removals, store, engine } = yield* counterSetUp([]);
      yield* engine.mutate("counter/inc", { id: "c" });
      // The acknowledgement's removal of the body is refused, after the entry is parked.
      yield* refuse(removals, ["legation/journal/client-a/1"], true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);

      // The entry is in the tail alone: not pushable, and not replayed twice in the overlay.
      expect(yield* store.pendingMutations).toEqual([]);
      expect(yield* tailOf(store)).toEqual(["client-a#1"]);
      expect(yield* counterValue(engine)).toBe(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a seed waits for the overlay lock, so no pull's release is in flight across its rows",
    () =>
      Effect.gen(function* () {
        const inner = yield* ClientStoreModule.makeMemory;
        const holdNext = yield* Ref.make(false);
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const store: ClientStore = {
          ...inner,
          putRow: (collection, row) =>
            Ref.getAndSet(holdNext, false).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(reached, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(inner.putRow(collection, row))
                    )
                  : inner.putRow(collection, row)
              )
            ),
        };
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);

        yield* Ref.set(holdNext, true);
        const seeding = yield* Effect.forkChild(
          engine.seed([{ collection: "counters", id: "c", version: 1, value: { id: "c", n: 4 } }])
        );
        yield* Deferred.await(reached);

        // A read started while the seed holds its writes must wait for them.
        const done = yield* Ref.make(false);
        const reading = yield* Effect.forkChild(
          counterValue(engine).pipe(Effect.tap(() => Ref.set(done, true)))
        );
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
        expect(yield* Ref.get(done)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(seeding);
        expect(yield* Fiber.join(reading)).toBe(4);
      })
  );

  it.effect("a reset waits for the overlay lock while it clears the confirmed rows", () =>
    Effect.gen(function* () {
      const inner = yield* ClientStoreModule.makeMemory;
      yield* inner.putRow("counters", { id: "c", version: 1, value: { id: "c", n: 4 } });
      const holdNext = yield* Ref.make(false);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const store: ClientStore = {
        ...inner,
        clearRows: Ref.getAndSet(holdNext, false).pipe(
          Effect.flatMap((hold) =>
            hold
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(inner.clearRows)
                )
              : inner.clearRows
          )
        ),
      };
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);

      yield* Ref.set(holdNext, true);
      const resetting = yield* Effect.forkChild(
        engine.reset("sha256:alice" as Identity.Fingerprint)
      );
      yield* Deferred.await(reached);

      // A read started while the reset clears the rows must wait, and then see them cleared.
      const done = yield* Ref.make(false);
      const reading = yield* Effect.forkChild(
        counterValue(engine).pipe(Effect.tap(() => Ref.set(done, true)))
      );
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      expect(yield* Ref.get(done)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(resetting);
      expect(yield* Fiber.join(reading)).toBeUndefined();
    })
  );
});

// The in-process finish's reads and its failure boundary (#387 review). Key-value only: the memory
// store's finish performs no I/O.
describe("the in-process finish reads the record, and seals only after it writes (#387 review)", () => {
  it.effect(
    "a failed read of the release record fails that row write, and the next write succeeds",
    () =>
      Effect.gen(function* () {
        const { spy, failNext } = yield* spyKeyValue("legation/releaseIntent");
        const store = yield* ClientStoreModule.makeKeyValue().pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, spy)
        );
        yield* store.beginRelease({
          lastMutationIds: {},
          patch: [
            { _tag: "Put", collection: "counters", id: "c", version: 1, value: { id: "c", n: 1 } },
          ],
        });
        // The finish's read of the record fails once. Nothing has been written, so the write is refused alone.
        yield* Ref.set(failNext, true);
        expect(Exit.isFailure(yield* Effect.exit(putCounter(store, "c", 5)))).toBe(true);
        expect(yield* rowCount(store, "c")).toBeUndefined();

        // The store is not sealed: the record is still outstanding, so this write finishes it and lands.
        yield* putCounter(store, "c", 5);
        expect(yield* rowCount(store, "c")).toBe(5);
        // The finish wrote the record off, so a reopen does not re-apply its patch (c = 1) over the write.
        const reopened = yield* ClientStoreModule.makeKeyValue();
        expect(yield* rowCount(reopened, "c")).toBe(5);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a failed read with only a parked copy outstanding fails that write alone", () =>
    Effect.gen(function* () {
      const { spy, failNext } = yield* spyKeyValue("legation/releaseIntent");
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, spy)
      );
      // A parked entry whose journal copy the next finish must drop, and no record.
      yield* store.appendMutation(mutation("c1", 1));
      yield* store.parkUnpulled([mutation("c1", 1)]);
      yield* Ref.set(failNext, true);
      expect(Exit.isFailure(yield* Effect.exit(putCounter(store, "c", 5)))).toBe(true);

      yield* putCounter(store, "c", 5);
      expect(yield* rowCount(store, "c")).toBe(5);
      expect(yield* store.pendingMutations).toEqual([]);
      expect(yield* tailOf(store)).toEqual(["c1#1"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a row write on a settled store reads no release record", () =>
    Effect.gen(function* () {
      const { spy, reads } = yield* spyKeyValue("legation/releaseIntent");
      const store = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, spy)
      );
      // A release finished by a write leaves nothing for the writes after it to finish.
      yield* store.beginRelease({ lastMutationIds: {}, patch: [] });
      yield* putCounter(store, "c", 1);
      yield* Ref.set(reads, 0);
      for (let i = 0; i < 20; i++) yield* putCounter(store, `r${i}`, i);
      yield* store.delRow("counters", "r0");
      expect(yield* Ref.get(reads)).toBe(0);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("the engine's clears (#387 review)", () => {
  it.effect("a clearRows waits for the overlay lock while it clears the confirmed rows", () =>
    Effect.gen(function* () {
      const inner = yield* ClientStoreModule.makeMemory;
      yield* inner.putRow("counters", { id: "c", version: 1, value: { id: "c", n: 4 } });
      const holdNext = yield* Ref.make(false);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const store: ClientStore = {
        ...inner,
        clearRows: Ref.getAndSet(holdNext, false).pipe(
          Effect.flatMap((hold) =>
            hold
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(inner.clearRows)
                )
              : inner.clearRows
          )
        ),
      };
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);

      yield* Ref.set(holdNext, true);
      const clearing = yield* Effect.forkChild(engine.clearRows);
      yield* Deferred.await(reached);

      // A read started while the clear holds the store must wait, and then see the rows cleared.
      const done = yield* Ref.make(false);
      const reading = yield* Effect.forkChild(
        counterValue(engine).pipe(Effect.tap(() => Ref.set(done, true)))
      );
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      expect(yield* Ref.get(done)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clearing);
      expect(yield* Fiber.join(reading)).toBeUndefined();
    })
  );
});

/**
 * Yields until `condition` holds, and says whether it did. The explicit wait for a background pull
 * (#337): bounded, so a pull that never comes makes the caller's `expect` fail rather than hang the test.
 */
const settles = <E>(condition: Effect.Effect<boolean, E>): Effect.Effect<boolean, E> =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (yield* condition) return true;
      yield* Effect.yieldNow;
    }
    return false;
  });

/**
 * The in-memory transport with its pulls counted. `failing` makes each pull fail as a dropped
 * connection does (`failed` counts those), and `gate`, when set, holds each pull until the test
 * releases it, so a test can keep a background pull in flight while pushes run.
 */
const probedTransport = (inner: ClientTransport) =>
  Effect.gen(function* () {
    const pulls = yield* Ref.make(0);
    const failed = yield* Ref.make(0);
    const failing = yield* Ref.make(false);
    const gate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
    const transport: ClientTransport = {
      ...inner,
      pull: (request) =>
        Ref.update(pulls, (n) => n + 1).pipe(
          Effect.andThen(Ref.get(gate)),
          Effect.flatMap((held) => (held === undefined ? Effect.void : Deferred.await(held))),
          Effect.andThen(Ref.get(failing)),
          Effect.flatMap((down) =>
            down
              ? Ref.update(failed, (n) => n + 1).pipe(
                  Effect.andThen(Effect.fail(new TransportError({ message: "connection dropped" })))
                )
              : inner.pull(request)
          )
        ),
    };
    return { transport, pulls, failed, failing, gate };
  });

/** The counter client over `transport`, with `unpulledLimit` and an optional pull retry policy. */
const engineWith = (
  transport: ClientTransport,
  store: ClientStore,
  unpulledLimit: number,
  retry?: ClientEngineModule.RetryOptions
) =>
  ClientEngineModule.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators: counterMutators,
    unpulledLimit,
    ...(retry === undefined ? {} : { retry }),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );

/**
 * Runs `body` with the warnings the engine logs, and the names of the spans it opens. A background pull
 * opens its `clientPull` span when its fibre starts, before it queues for the pull lock, so counting those
 * spans counts the pull fibres a burst forked, including the ones the pull lock makes skip (#337).
 */
const observed = <A, E, R>(
  body: (warnings: Array<string>, spans: Array<string>) => Effect.Effect<A, E, R>
) => {
  const warnings: Array<string> = [];
  const spans: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const tracer = Tracer.make({
    span(options) {
      spans.push(options.name);
      return Tracer.nativeTracer.span(options);
    },
  });
  return body(warnings, spans).pipe(
    Effect.withLogger(logger),
    Effect.provideService(Tracer.Tracer, tracer)
  );
};

// Pull ahead of the bound (#337). With no pokes and no `pullInterval` nothing pulls on its own, so a
// run of pushes used to reach the bound and overflow, reverting the view. A push that takes the tail
// to half the bound now starts one pull in the background, which the push does not wait for.
describe("a push that takes the tail to half the bound pulls ahead of it (#337)", () => {
  // The tail length at which a push starts the pull, as the engine sets it.
  const pullAheadAt = Math.ceil(SMALL_LIMIT / 2);
  // A bound large enough that a burst stays under it while one pull is held.
  const BURST_LIMIT = 64;
  const pullFibres = (spans: ReadonlyArray<string>) =>
    spans.filter((name) => name === Telemetry.span.clientPull).length;

  it.effect(
    "with pokes off and no pullInterval, a run of pushes past the bound never takes the tail past it",
    () =>
      observed((warnings) =>
        Effect.gen(function* () {
          const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
          const store = yield* ClientStoreModule.makeMemory;
          const probe = yield* probedTransport(yield* makeInMemory(server, "group-a"));
          const engine = yield* engineWith(probe.transport, store, SMALL_LIMIT);
          yield* engine.subscribe(countersSubset);

          let widest = 0;
          for (let i = 1; i <= 3 * SMALL_LIMIT; i++) {
            yield* engine.mutate("counter/inc", { id: "c" });
            yield* engine.push;
            const depth = (yield* store.unpulled).length;
            widest = Math.max(widest, depth);
            // A crossing starts a pull that releases the whole tail. Wait for it, so the next push
            // sees the pull's effect; without the trigger the wait gives up and the tail reaches the bound.
            if (depth >= pullAheadAt) {
              yield* settles(
                store.unpulled.pipe(Effect.map((tail) => Arr.isReadonlyArrayEmpty(tail)))
              );
            }
          }

          // Nothing is released early, so the widest tail is the check on the bound; no pull is needed to keep it there.
          expect(warnings, "the engine logs no warning in this run").toEqual([]);
          expect(widest).toBeLessThanOrEqual(SMALL_LIMIT);
          expect(yield* counterValue(engine)).toBe(3 * SMALL_LIMIT);
        })
      )
  );

  it.effect(
    "a burst of pushes past the threshold starts one pull, and the pushes do not wait for it",
    () =>
      observed((warnings, spans) =>
        Effect.gen(function* () {
          const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
          const store = yield* ClientStoreModule.makeMemory;
          const probe = yield* probedTransport(yield* makeInMemory(server, "group-a"));
          const engine = yield* engineWith(probe.transport, store, BURST_LIMIT);
          yield* engine.subscribe(countersSubset);

          // The first pull the burst starts is held at the gate; every push below must still complete.
          const release = yield* Deferred.make<void>();
          yield* Ref.set(probe.gate, release);
          const burst = 40;
          for (let i = 0; i < burst; i++) {
            yield* engine.mutate("counter/inc", { id: "c" });
            yield* engine.push;
          }
          expect((yield* store.unpulled).length).toBe(burst);

          expect(
            yield* settles(Ref.get(probe.pulls).pipe(Effect.map((n) => n === 1))),
            "the pull the burst starts"
          ).toBe(true);
          // Give any second pull the burst might start its chance to run: none may, while one is held.
          for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
          expect(yield* Ref.get(probe.pulls), "pulls while one is held").toBe(1);
          // The pull lock would skip a second fibre's pull, so only the fibres themselves show a leak.
          expect(pullFibres(spans), "pull fibres forked while one is held").toBe(1);

          yield* Deferred.succeed(release, undefined);
          expect(
            yield* settles(
              store.unpulled.pipe(Effect.map((tail) => Arr.isReadonlyArrayEmpty(tail)))
            ),
            "the held pull to release the tail"
          ).toBe(true);
          expect(yield* Ref.get(probe.pulls), "pulls after the held one ends").toBe(1);
          expect(pullFibres(spans), "pull fibres forked by the burst").toBe(1);
          expect(yield* counterValue(engine)).toBe(burst);
          expect(warnings).toEqual([]);
        })
      )
  );

  it.effect("a pull that fails does not wedge later pushes, and a later crossing pulls again", () =>
    observed((warnings) =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const probe = yield* probedTransport(yield* makeInMemory(server, "group-a"));
        // No retries: the failing pull ends at once, so the test does not wait out a backoff.
        const engine = yield* engineWith(probe.transport, store, BURST_LIMIT, {
          pull: Schedule.recurs(0),
        });
        yield* engine.subscribe(countersSubset);
        yield* Ref.set(probe.failing, true);

        let total = 0;
        const pushOne = Effect.gen(function* () {
          yield* engine.mutate("counter/inc", { id: "c" });
          yield* engine.push;
          total += 1;
        });

        // Crossing the threshold starts a pull, and it fails.
        for (let i = 0; i < BURST_LIMIT / 2; i++) yield* pushOne;
        expect(
          yield* settles(Ref.get(probe.failed).pipe(Effect.map((n) => n >= 1))),
          "the pull ahead to fail"
        ).toBe(true);
        // Pushes carry on while the pull is down: each is acknowledged and the journal drains.
        for (let i = 0; i < 8; i++) {
          yield* pushOne;
          expect(yield* store.pendingMutations).toEqual([]);
        }

        // The connection returns. A push that starts a pull after the failed one has ended releases the
        // tail; a push that lands while it is still ending starts none, so keep pushing until one does.
        yield* Ref.set(probe.failing, false);
        for (let i = 0; i < 16 && Arr.isReadonlyArrayNonEmpty(yield* store.unpulled); i++) {
          yield* pushOne;
          yield* Effect.yieldNow;
        }
        expect(
          yield* settles(store.unpulled.pipe(Effect.map((tail) => Arr.isReadonlyArrayEmpty(tail)))),
          "a later pull to release the tail"
        ).toBe(true);

        expect(yield* Ref.get(probe.failed)).toBeGreaterThanOrEqual(1);
        expect(yield* counterValue(engine)).toBe(total);
        expect(warnings).toEqual([]);
      })
    )
  );
});

describe("dehydrate reads one state of the store (#392)", () => {
  // A KeyValueStore whose first read of `parkKey` after `armed` is set signals `reached` and waits on
  // `release`. Parking on the cookie leaves the snapshot's row reads behind and its journal and tail
  // reads ahead of whatever the test lands. Parking on the unpulled index leaves the journal read behind
  // and the tail read ahead, so an acknowledgement that lands there is seen by the tail alone.
  const parkedAt = (
    base: KeyValueStore.KeyValueStore,
    parkKey: string,
    armed: Ref.Ref<boolean>,
    reached: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>
  ) =>
    KeyValueStore.KeyValueStore.of({
      ...base,
      get: (key) =>
        Effect.gen(function* () {
          if (key === parkKey && (yield* Ref.getAndSet(armed, false))) {
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
          }
          return yield* base.get(key);
        }),
    });

  it.effect("a pull that lands between the snapshot's reads is seen whole or not at all", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const base = yield* KeyValueStore.KeyValueStore;
      const armed = yield* Ref.make(false);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const source = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(
          KeyValueStore.KeyValueStore,
          parkedAt(base, "legation/cookie", armed, reached, release)
        )
      );
      const engine = yield* makeCounterEngine(server, source);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      // Acknowledged and parked in the tail: the effect is shown by the overlay, and no row holds it yet.
      yield* engine.push;
      expect(yield* tailOf(source)).toEqual(["client-a#1"]);

      yield* Ref.set(armed, true);
      const snapshotting = yield* Effect.forkChild(Hydration.dehydrate(source));
      yield* Deferred.await(reached);
      // The pull lands now, if nothing holds it off: it writes the row, the cookie and the release.
      const pulling = yield* Effect.forkChild(engine.pull);
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const snapshot = yield* Fiber.join(snapshotting);
      yield* Fiber.join(pulling);
      expect(yield* counterValue(engine)).toBe(1);

      // Hydrated into a fresh store with no pull, the view shows the same count as the source.
      // A fresh backing store: the target shares nothing with the source.
      const target = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provide(Layer.fresh(KeyValueStore.layerMemory))
      );
      yield* Hydration.hydrate(target, JSON.parse(JSON.stringify(snapshot)));
      const viewer = yield* makeCounterEngine(server, target);
      yield* viewer.subscribe(countersSubset);
      expect(yield* counterValue(viewer)).toBe(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a push acknowledgement between the journal and tail reads is seen whole", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const base = yield* KeyValueStore.KeyValueStore;
      const armed = yield* Ref.make(false);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The first read of the unpulled index is the tail's first read: the journal has been read by then,
      // and the acknowledgement moves the entry from the journal into the tail before the tail is read.
      const source = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provideService(
          KeyValueStore.KeyValueStore,
          parkedAt(base, "legation/unpulledIndex", armed, reached, release)
        )
      );
      const engine = yield* makeCounterEngine(server, source);
      yield* engine.subscribe(countersSubset);
      // Journaled, not yet pushed: the acknowledgement is what moves it from the journal to the tail.
      yield* engine.mutate("counter/inc", { id: "c" });

      yield* Ref.set(armed, true);
      const snapshotting = yield* Effect.forkChild(Hydration.dehydrate(source));
      yield* Deferred.await(reached);
      const pushing = yield* Effect.forkChild(engine.push);
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const snapshot = yield* Fiber.join(snapshotting);
      yield* Fiber.join(pushing);
      expect(yield* tailOf(source)).toEqual(["client-a#1"]);
      // The entry is in the snapshot exactly once, in the journal or in the tail, never both.
      expect(snapshot.journal.length + (snapshot.unpulled?.length ?? 0)).toBe(1);

      // A fresh backing store: the target shares nothing with the source.
      const target = yield* ClientStoreModule.makeKeyValue().pipe(
        Effect.provide(Layer.fresh(KeyValueStore.layerMemory))
      );
      yield* Hydration.hydrate(target, JSON.parse(JSON.stringify(snapshot)));
      const viewer = yield* makeCounterEngine(server, target);
      yield* viewer.subscribe(countersSubset);
      expect(yield* counterValue(viewer)).toBe(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  // Every part of the snapshot is the member's read, in a state with rows, a cookie, a tail and a journal.
  const expectSnapshotIsTheMembers = (store: ClientStore) =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      yield* engine.pull;
      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      yield* engine.mutate("counter/inc", { id: "c" });

      const state = yield* defined(store.snapshot);
      expect(state.rows.map((entry) => entry.row)).toEqual(yield* store.listRows("counters"));
      expect(state.cookie).toBe(yield* store.getCookie);
      expect(state.journal).toEqual(yield* store.pendingMutations);
      expect(state.unpulled).toEqual(yield* store.unpulled);
      expect(state.unpulled).toHaveLength(1);
      expect(state.journal).toHaveLength(1);
    });

  it.effect("the memory store's snapshot is the state its members read", () =>
    Effect.gen(function* () {
      yield* expectSnapshotIsTheMembers(yield* ClientStoreModule.makeMemory);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("the key-value store's snapshot is the state its members read", () =>
    Effect.gen(function* () {
      yield* expectSnapshotIsTheMembers(yield* ClientStoreModule.makeKeyValue());
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  // A pull writes the rows, then the cookie, under the memory store's lock. A snapshot reads the rows
  // first and the cookie after them, so unlocked it can pair the rows of one pull with the cookie of a
  // later one, a pairing no serial order produces. `MaxOpsBeforeYield` of 5, the house value
  // (journal-append-gap.test.ts), makes the two fibers yield often enough that a pull lands between the
  // snapshot's reads on the unlocked code (#392). A budget of 1 starves the pull and never finishes.
  it.live("a memory snapshot never pairs one pull's rows with another pull's cookie", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const rounds = 200;
      let torn = 0;
      const seen = new Set<number | undefined>();
      const pulls = Effect.gen(function* () {
        for (let k = 1; k <= rounds; k++) {
          yield* defined(store.commitPull)({
            lastMutationIds: {},
            cookie: `c${k}`,
            patch: [{ _tag: "Put", collection: "counters", id: "a", version: k, value: { n: k } }],
          });
        }
      });
      const reads = Effect.gen(function* () {
        for (let i = 0; i < rounds * 2; i++) {
          const state = yield* defined(store.snapshot);
          const row = state.rows.find((entry) => entry.row.id === "a")?.row;
          const n = row === undefined ? undefined : (row.value as { readonly n: number }).n;
          seen.add(n);
          if (state.cookie !== (n === undefined ? undefined : `c${n}`)) torn++;
        }
      });
      const pulling = yield* Effect.forkChild(pulls);
      const reading = yield* Effect.forkChild(reads);
      yield* Fiber.join(pulling);
      yield* Fiber.join(reading);
      // The reads must interleave with the pulls, or the check above is vacuous.
      expect(seen.size).toBeGreaterThan(1);
      expect(torn).toBe(0);
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 5))
  );
});
