/**
 * Paced mutations (#117): debounce/throttle/coalesce strategies over
 * `ClientEngine.mutateWithAck` + `dropIfPending`. Time is driven by TestClock
 * so bursts are deterministic; "bounded overlay replays" is verified via the
 * mutation ids actually consumed (`journal()` assigns one per `mutateWithAck`
 * call, so counting ids consumed IS counting journal writes/overlay
 * invalidations — the direct, race-free proxy, unlike subscribing to
 * `engineEvents` mid-burst).
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Schema, Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Paced from "../Paced.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import {
  ClientTransport,
  makeInMemory,
  type ClientTransport as CT,
  type ServerHandler,
} from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const allTodos = Subset.make({ collection: "todos" });

const makeEngine = (transport: CT, store: ClientStore) =>
  ClientEngineModule.make({ clientId: "client-a", clientGroupId: "group-a", mutators }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );

const setup = Effect.gen(function* () {
  const handler = yield* makeServer;
  const transport = yield* makeInMemory(handler, "group-a");
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* makeEngine(transport, store);
  yield* engine.subscribe(allTodos);
  return { engine, store, transport };
});

const todo = (id: string, title: string): Todo => ({ id, title, done: false });
const idsOf = (mutations: ReadonlyArray<{ readonly mutationId: number }>) =>
  mutations.map((m) => m.mutationId);

describe("Paced (#117)", () => {
  it.effect("coalesce collapses consecutive same-key calls, leaves other keys alone", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* setup;
      const paced = yield* Paced.coalesce(engine, "todo/set");

      for (let i = 0; i < 10; i++) yield* paced.call("t1", todo("t1", `v${i}`));
      yield* paced.call("t2", todo("t2", "other"));

      const pending = yield* store.pendingMutations;
      // Ten calls for t1 collapse to its newest entry; t2 is untouched by that
      // compaction — two keys, two surviving entries.
      expect(pending).toHaveLength(2);
      const t1 = pending.find((m) => (m.args as Todo).id === "t1")!;
      const t2 = pending.find((m) => (m.args as Todo).id === "t2")!;
      expect((t1.args as Todo).title).toBe("v9");
      expect((t2.args as Todo).title).toBe("other");
      // Every call journaled (fully durable) — ids 1..11 were all consumed,
      // just nine of them (t1's v0..v8) were compacted away afterwards.
      expect(t1.mutationId).toBe(10);
      expect(t2.mutationId).toBe(11);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "debounce: a 50-keystroke burst journals only a leading + trailing entry, bounded replays",
    () =>
      Effect.gen(function* () {
        const { engine, store } = yield* setup;
        const paced = yield* Paced.debounce(engine, "todo/set", Duration.millis(200));

        for (let i = 0; i < 50; i++) yield* paced.call("t1", todo("t1", `keystroke-${i}`));

        // Still inside the window: only the leading-edge entry exists.
        const during = yield* store.pendingMutations;
        expect(during).toHaveLength(1);
        expect(during[0]!.mutationId).toBe(1);
        expect((during[0]!.args as Todo).title).toBe("keystroke-0");

        // The window closes: the trailing flush supersedes the leading entry
        // with the latest args.
        yield* TestClock.adjust(Duration.millis(200));
        const after = yield* store.pendingMutations;
        expect(after).toHaveLength(1);
        expect((after[0]!.args as Todo).title).toBe("keystroke-49");
        // Exactly two `mutateWithAck` calls happened for 50 keystrokes (ids 1
        // and 2) — i.e. exactly two journal writes / overlay invalidations,
        // not fifty: "bounded overlay replays".
        expect(after[0]!.mutationId).toBe(2);
      }).pipe(Effect.scoped)
  );

  it.effect("debounce: an isolated call (no burst) journals once, no wasted trailing flush", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* setup;
      const paced = yield* Paced.debounce(engine, "todo/set", Duration.millis(200));

      yield* paced.call("t1", todo("t1", "only"));
      yield* TestClock.adjust(Duration.millis(200));

      const pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      // Only one mutation id was ever consumed — the trailing timer saw
      // nothing new buffered and skipped its flush.
      expect(pending[0]!.mutationId).toBe(1);
    }).pipe(Effect.scoped)
  );

  it.effect("throttle: periodic flushes while calls keep arriving, at most one per window", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* setup;
      const paced = yield* Paced.throttle(engine, "todo/set", Duration.millis(100));

      // Leading edge.
      yield* paced.call("t1", todo("t1", "v0"));
      expect(idsOf(yield* store.pendingMutations)).toEqual([1]);

      // Calls inside the first window buffer; nothing new journals yet.
      yield* paced.call("t1", todo("t1", "v1"));
      yield* paced.call("t1", todo("t1", "v2"));
      expect(idsOf(yield* store.pendingMutations)).toEqual([1]);

      // The window elapses: the buffered latest value flushes, superseding v0.
      yield* TestClock.adjust(Duration.millis(100));
      let pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      expect((pending[0]!.args as Todo).title).toBe("v2");
      expect(pending[0]!.mutationId).toBe(2);

      // More calls arrive in the new window, then it goes quiet.
      yield* paced.call("t1", todo("t1", "v3"));
      yield* TestClock.adjust(Duration.millis(100));
      pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      expect((pending[0]!.args as Todo).title).toBe("v3");
      expect(pending[0]!.mutationId).toBe(3);

      // No further calls: the next tick finds nothing dirty and goes idle.
      yield* TestClock.adjust(Duration.millis(100));
      pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.mutationId).toBe(3);
    }).pipe(Effect.scoped)
  );

  it.effect("dropIfPending never compacts an entry while a push may still have it in flight", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const base = yield* makeInMemory(handler, "group-gate");
      const store = yield* ClientStoreModule.makeMemory;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gated: CT = {
        ...base,
        push: (request) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(base.push(request))
          ),
      };
      const engine = yield* makeEngine(gated, store);
      yield* engine.subscribe(allTodos);
      const paced = yield* Paced.coalesce(engine, "todo/set");

      yield* paced.call("t1", todo("t1", "first"));
      const firstId = (yield* store.pendingMutations)[0]!.mutationId;

      // Start a push and let it block right after reading the pending
      // snapshot — the entry is now claimed, but not yet acknowledged.
      const pushFiber = yield* Effect.forkChild(engine.push);
      yield* Deferred.await(started);

      // A coalescing call arrives while the push is in flight: the old
      // entry must survive untouched — dropping it here would silently
      // discard whatever the in-flight push may already be committing.
      yield* paced.call("t1", todo("t1", "second"));
      const duringPush = yield* store.pendingMutations;
      expect(idsOf(duringPush)).toContain(firstId);
      expect(duringPush).toHaveLength(2); // the old entry plus the new, uncompacted

      // Release the push; it acknowledges the first entry normally.
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pushFiber);
      const afterPush = yield* store.pendingMutations;
      expect(idsOf(afterPush)).not.toContain(firstId);
      expect(afterPush).toHaveLength(1); // only the second, still-unpushed entry remains

      // Compaction resumes normally once no push is in flight.
      yield* paced.call("t1", todo("t1", "third"));
      const final = yield* store.pendingMutations;
      expect(final).toHaveLength(1);
      expect((final[0]!.args as Todo).title).toBe("third");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "property: mutation ids stay strictly increasing and journal-ordered across randomized paced bursts",
    () =>
      Effect.gen(function* () {
        const { engine, store } = yield* setup;
        const debounced = yield* Paced.debounce(engine, "todo/set", Duration.millis(30));
        const throttled = yield* Paced.throttle(engine, "todo/set", Duration.millis(30));
        const coalesced = yield* Paced.coalesce(engine, "todo/set");
        const strategies = [debounced, throttled, coalesced];

        // Deterministic PRNG (no new dependency): exercise many randomized
        // interleavings of the three strategies across a handful of keys and
        // assert the invariant holds after every step, not just at the end.
        let seed = 1234567;
        const next = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x7fffffff;
        };

        for (let round = 0; round < 300; round++) {
          const strategy = strategies[Math.floor(next() * strategies.length)]!;
          const key = `k${Math.floor(next() * 4)}`;
          yield* strategy.call(key, todo(key, `r${round}`));
          if (next() < 0.25) yield* TestClock.adjust(Duration.millis(10));

          const pending = yield* store.pendingMutations;
          const ids = idsOf(pending.filter((m) => m.clientId === "client-a"));
          // Strictly increasing in journal (array) order: compaction only ever
          // removes entries, never reorders or renumbers the survivors — the
          // hard boundary (never mutate/reorder a journal entry) holds even
          // under adversarial interleaving of all three strategies.
          for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
        }

        // Let every outstanding trailing/periodic timer settle.
        yield* TestClock.adjust(Duration.seconds(1));
        const final = yield* store.pendingMutations;
        const finalIds = idsOf(final.filter((m) => m.clientId === "client-a"));
        for (let i = 1; i < finalIds.length; i++)
          expect(finalIds[i]!).toBeGreaterThan(finalIds[i - 1]!);
      }).pipe(Effect.scoped)
  );
});
