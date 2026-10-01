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
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as Hydration from "../Hydration.js";
import { TransportError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Paced from "../Paced.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";
import { KeyValueStore } from "effect/persistence";
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

/**
 * Wrap a store to count `appendMutation` calls. Since #249 a compaction
 * renumbers survivors and rewinds the id counter, so ids consumed no longer
 * count journal writes; appends do.
 */
const counting = (store: ClientStore) => {
  const counter = { appends: 0 };
  const wrapped: ClientStore = {
    ...store,
    appendMutation: (mutation) => {
      counter.appends += 1;
      return store.appendMutation(mutation);
    },
  };
  return { wrapped, counter };
};

const setup = Effect.gen(function* () {
  const handler = yield* makeServer;
  const transport = yield* makeInMemory(handler, "group-a");
  const inner = yield* ClientStoreModule.makeMemory;
  const { wrapped: store, counter } = counting(inner);
  const engine = yield* makeEngine(transport, store);
  yield* engine.subscribe(allTodos);
  return { engine, store, transport, counter };
});

const todo = (id: string, title: string): Todo => ({ id, title, done: false });
const idsOf = (mutations: ReadonlyArray<{ readonly mutationId: number }>) =>
  mutations.map((m) => m.mutationId);

/**
 * A real `MemoryBackend` (it enforces the contiguous-id rule) whose handler
 * also logs each title it actually applies, in order. Idempotently skipped
 * mutations never reach a handler, so the log is exactly "what the server
 * applied".
 */
const makeLoggingServer = Effect.gen(function* () {
  const applied: Array<string> = [];
  const backend = yield* MemoryBackend.make({
    "todo/set": (args, writer) =>
      Effect.sync(() => void applied.push((args as Todo).title)).pipe(
        Effect.andThen(writer.put("todos", (args as Todo).id, args)),
        Effect.asVoid
      ),
  });
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  const handler: ServerHandler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
  return { handler, applied, backend };
});

const titlesOf = (mutations: ReadonlyArray<Mutation>) =>
  mutations.map((m) => (m.args as Todo).title);

/** Fail after the server has applied the push: the response is lost in transit. */
const lossyAfterApply = (base: CT, mode: Ref.Ref<"ok" | "response-lost" | "request-lost">): CT => ({
  ...base,
  push: (request) =>
    Ref.get(mode).pipe(
      Effect.flatMap((current) => {
        if (current === "request-lost") {
          return Effect.fail(new TransportError({ message: "request never arrived" }));
        }
        return base
          .push(request)
          .pipe(
            Effect.flatMap((response) =>
              current === "response-lost"
                ? Effect.fail(new TransportError({ message: "response lost" }))
                : Effect.succeed(response)
            )
          );
      })
    ),
});

const setupLossy = Effect.gen(function* () {
  const { handler, applied, backend } = yield* makeLoggingServer;
  const base = yield* makeInMemory(handler, "group-a");
  const mode = yield* Ref.make<"ok" | "response-lost" | "request-lost">("ok");
  const transport = lossyAfterApply(base, mode);
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* makeEngine(transport, store);
  yield* engine.subscribe(allTodos);
  return { engine, store, applied, backend, mode };
});

describe("Paced (#117)", () => {
  it.effect("coalesce collapses consecutive same-key calls, leaves other keys alone", () =>
    Effect.gen(function* () {
      const { engine, store, counter } = yield* setup;
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
      // Every call journaled (fully durable): eleven appends, nine of them
      // (t1's v0..v8) compacted away afterwards — and the survivors renumbered
      // so the ids the backend sees are gap-free (#249).
      expect(counter.appends).toBe(11);
      expect(t1.mutationId).toBe(1);
      expect(t2.mutationId).toBe(2);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "debounce: a 50-keystroke burst journals only a leading + trailing entry, bounded replays",
    () =>
      Effect.gen(function* () {
        const { engine, store, counter } = yield* setup;
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
        // Exactly two `mutateWithAck` calls happened for 50 keystrokes — i.e.
        // exactly two journal writes / overlay invalidations, not fifty:
        // "bounded overlay replays". The survivor was renumbered back to 1 so
        // the journal stays gap-free (#249).
        expect(counter.appends).toBe(2);
        expect(after[0]!.mutationId).toBe(1);
      }).pipe(Effect.scoped)
  );

  it.effect("debounce: an isolated call (no burst) journals once, no wasted trailing flush", () =>
    Effect.gen(function* () {
      const { engine, store, counter } = yield* setup;
      const paced = yield* Paced.debounce(engine, "todo/set", Duration.millis(200));

      yield* paced.call("t1", todo("t1", "only"));
      yield* TestClock.adjust(Duration.millis(200));

      const pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      // Only one append ever happened — the trailing timer saw nothing new
      // buffered and skipped its flush.
      expect(counter.appends).toBe(1);
      expect(pending[0]!.mutationId).toBe(1);
    }).pipe(Effect.scoped)
  );

  it.effect("throttle: periodic flushes while calls keep arriving, at most one per window", () =>
    Effect.gen(function* () {
      const { engine, store, counter } = yield* setup;
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
      expect(counter.appends).toBe(2);
      expect(pending[0]!.mutationId).toBe(1); // renumbered (#249)

      // More calls arrive in the new window, then it goes quiet.
      yield* paced.call("t1", todo("t1", "v3"));
      yield* TestClock.adjust(Duration.millis(100));
      pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      expect((pending[0]!.args as Todo).title).toBe("v3");
      expect(counter.appends).toBe(3);
      expect(pending[0]!.mutationId).toBe(1);

      // No further calls: the next tick finds nothing dirty and goes idle.
      yield* TestClock.adjust(Duration.millis(100));
      pending = yield* store.pendingMutations;
      expect(pending).toHaveLength(1);
      expect(counter.appends).toBe(3);
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
    "property: mutation ids stay contiguous from 1 and journal-ordered across randomized paced bursts",
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
          // Nothing has been pushed, so the journal is the contiguous run
          // 1..n in journal (array) order: compaction removes entries and
          // renumbers the survivors (#249) but never reorders them, and never
          // leaves a gap the backend would reject — even under adversarial
          // interleaving of all three strategies.
          expect(ids).toEqual(ids.map((_, i) => i + 1));
        }

        // Let every outstanding trailing/periodic timer settle.
        yield* TestClock.adjust(Duration.seconds(1));
        const final = yield* store.pendingMutations;
        const finalIds = idsOf(final.filter((m) => m.clientId === "client-a"));
        expect(finalIds).toEqual(finalIds.map((_, i) => i + 1));
      }).pipe(Effect.scoped)
  );
});

describe("paced compaction renumbers the journal (#249)", () => {
  it.effect("a coalesced journal drains: the survivor is renumbered, not left behind a gap", () =>
    Effect.gen(function* () {
      const { engine, store, applied, backend } = yield* setupLossy;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      for (let n = 1; n <= 3; n++) yield* paced.call("1", todo("1", `e${n}`));

      // The reproduction from the issue: before the fix this was `[3]`, and
      // the push below failed with "Mutation id gap for client client-a: got
      // 3, expected 1".
      expect(idsOf(yield* store.pendingMutations)).toEqual([1]);

      const exit = yield* Effect.exit(engine.push);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied).toEqual(["e3"]);
      expect((yield* backend.lastMutationIds({ clientGroupId: "group-a" }))["client-a"]).toBe(1);
    }).pipe(Effect.scoped)
  );

  it.effect("debounce and throttle journals drain too", () =>
    Effect.gen(function* () {
      const { engine, store, applied } = yield* setupLossy;
      const debounced = yield* Paced.debounce(engine, "todo/set", Duration.millis(50));
      const throttled = yield* Paced.throttle(engine, "todo/set", Duration.millis(50));
      for (let n = 1; n <= 5; n++) {
        yield* debounced.call("d", todo("d", `d${n}`));
        yield* throttled.call("t", todo("t", `t${n}`));
      }
      yield* TestClock.adjust(Duration.millis(500));

      const pending = yield* store.pendingMutations;
      expect(idsOf(pending)).toEqual(pending.map((_, i) => i + 1));
      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied.filter((t) => t.startsWith("d")).at(-1)).toBe("d5");
      expect(applied.filter((t) => t.startsWith("t")).at(-1)).toBe("t5");
    }).pipe(Effect.scoped)
  );

  it.effect("preserves journal order across interleaved keys", () =>
    Effect.gen(function* () {
      const { engine, store, applied } = yield* setupLossy;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      for (const [key, title] of [
        ["a", "a1"],
        ["b", "b1"],
        ["a", "a2"],
        ["c", "c1"],
        ["b", "b2"],
        ["a", "a3"],
      ] as const) {
        yield* paced.call(key, todo(key, title));
      }

      // Survivors sit in the order they were journaled (c1, b2, a3), renumbered 1..3.
      const pending = yield* store.pendingMutations;
      expect(titlesOf(pending)).toEqual(["c1", "b2", "a3"]);
      expect(idsOf(pending)).toEqual([1, 2, 3]);

      yield* engine.push;
      expect(applied).toEqual(["c1", "b2", "a3"]);
      expect(yield* store.pendingMutations).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("renumbers from the last acknowledged id, not from 1", () =>
    Effect.gen(function* () {
      const { engine, store, applied, backend } = yield* setupLossy;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      yield* paced.call("a", todo("a", "a1"));
      yield* paced.call("a", todo("a", "a2"));
      yield* engine.push; // server now at 1
      expect(yield* store.pendingMutations).toEqual([]);

      yield* paced.call("a", todo("a", "a3"));
      yield* paced.call("a", todo("a", "a4"));
      yield* paced.call("b", todo("b", "b1"));
      const pending = yield* store.pendingMutations;
      expect(idsOf(pending)).toEqual([2, 3]);
      expect(titlesOf(pending)).toEqual(["a4", "b1"]);

      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied).toEqual(["a2", "a4", "b1"]);
      expect((yield* backend.lastMutationIds({ clientGroupId: "group-a" }))["client-a"]).toBe(3);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "compaction during an in-flight push leaves the claimed entry alone and stays gap-free",
    () =>
      Effect.gen(function* () {
        const { handler, applied } = yield* makeLoggingServer;
        const base = yield* makeInMemory(handler, "group-gate");
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
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeEngine(gated, store);
        yield* engine.subscribe(allTodos);
        const paced = yield* Paced.coalesce(engine, "todo/set");

        yield* paced.call("k", todo("k", "first"));
        const pushFiber = yield* Effect.forkChild(engine.push);
        yield* Deferred.await(started);

        // Both calls land while the push holds entry 1. Compaction is refused
        // (it waits for nothing; it just declines), so nothing is renumbered
        // under the in-flight request and the tail grows contiguously.
        yield* paced.call("k", todo("k", "second"));
        yield* paced.call("k", todo("k", "third"));
        expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2, 3]);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pushFiber);
        // The push acknowledged only what it sent.
        expect(idsOf(yield* store.pendingMutations)).toEqual([2, 3]);

        // With no push in flight, compaction resumes and renumbers from the ack.
        yield* paced.call("k", todo("k", "fourth"));
        const pending = yield* store.pendingMutations;
        // "second" stays: the coalescer only ever supersedes its own latest entry.
        expect(titlesOf(pending)).toEqual(["second", "fourth"]);
        expect(idsOf(pending)).toEqual([2, 3]);

        yield* engine.push;
        expect(yield* store.pendingMutations).toEqual([]);
        expect(applied).toEqual(["first", "second", "fourth"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "an entry a failed push may have delivered keeps its id (renumbering it would drop a write)",
    () =>
      Effect.gen(function* () {
        const { engine, store, applied, mode } = yield* setupLossy;
        const paced = yield* Paced.coalesce(engine, "todo/set");
        yield* paced.call("a", todo("a", "a1"));
        yield* paced.call("b", todo("b", "b1"));

        // The server applies 1 and 2, but the response is lost: the client
        // still holds both and cannot know they landed.
        yield* Ref.set(mode, "response-lost");
        expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
        expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2]);

        // A new edit for "b" would supersede entry 2. Dropping it and moving
        // the new entry down to id 2 would make the server skip the new edit
        // as a duplicate of the applied one: a silent lost write. Entry 2 is
        // frozen, so the new one is simply appended.
        yield* paced.call("b", todo("b", "b2"));
        expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2, 3]);

        yield* Ref.set(mode, "ok");
        yield* engine.push;
        expect(yield* store.pendingMutations).toEqual([]);
        // Each write applied exactly once, in order; "b2" was not swallowed.
        expect(applied).toEqual(["a1", "b1", "b2"]);
      }).pipe(Effect.scoped)
  );

  it.effect("a push that never reached the server freezes its entries too, and still drains", () =>
    Effect.gen(function* () {
      const { engine, store, applied, mode } = yield* setupLossy;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      yield* paced.call("a", todo("a", "a1"));
      yield* paced.call("b", todo("b", "b1"));

      yield* Ref.set(mode, "request-lost");
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);

      yield* paced.call("b", todo("b", "b2"));
      expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2, 3]);

      yield* Ref.set(mode, "ok");
      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied).toEqual(["a1", "b1", "b2"]);
    }).pipe(Effect.scoped)
  );

  it.effect("mutateWithAck handles and mutation states follow a renumbering", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* setupLossy;
      const a = yield* engine.mutateWithAck("todo/set", todo("a", "a1"));
      const b = yield* engine.mutateWithAck("todo/set", todo("b", "b1"));
      const c = yield* engine.mutateWithAck("todo/set", todo("c", "c1"));
      expect([a.mutationId, b.mutationId, c.mutationId]).toEqual([1, 2, 3]);

      const aOutcome = yield* Effect.forkChild(Effect.exit(a.acknowledged));
      const result = yield* engine.dropIfPending([1]);
      expect(result).toEqual({
        dropped: [1],
        renumbered: [
          { from: 2, to: 1 },
          { from: 3, to: 2 },
        ],
      });
      expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2]);

      // The dropped entry's waiter is released (interrupted), not leaked.
      expect(Exit.isFailure(yield* Fiber.join(aOutcome))).toBe(true);

      const states = yield* Stream.runHead(engine.mutationStates);
      const map = states._tag === "Some" ? states.value : HashMap.empty();
      const phaseAt = (id: number) => Option.getOrUndefined(HashMap.get(map, id));
      expect(phaseAt(1)).toMatchObject({ phase: "pending", mutationId: 1 });
      expect(phaseAt(1)).toMatchObject({ args: { title: "b1" } });
      expect(phaseAt(2)).toMatchObject({ phase: "pending", mutationId: 2 });
      expect(phaseAt(2)).toMatchObject({ args: { title: "c1" } });

      // b and c's handles, issued under the old ids 2 and 3, settle when the
      // backend acknowledges their new ids 1 and 2.
      yield* engine.push;
      expect(yield* b.acknowledged).toEqual({ _tag: "applied" });
      expect(yield* c.acknowledged).toEqual({ _tag: "applied" });
    }).pipe(Effect.scoped)
  );

  it.effect("several paced instances on one engine keep each other's ids current", () =>
    Effect.gen(function* () {
      const { engine, store, applied } = yield* setupLossy;
      const p = yield* Paced.coalesce(engine, "todo/set");
      const q = yield* Paced.coalesce(engine, "todo/set");

      yield* p.call("p", todo("p", "p1")); //          [p1]
      yield* q.call("q", todo("q", "q1")); //          [p1, q1]
      yield* q.call("q", todo("q", "q2")); //          [p1, q2]   (q2 renumbered 3 -> 2)
      // p supersedes entry 1, which moves q's entry from 2 to 1. If q kept
      // remembering 2, its next call would drop p's brand new entry instead.
      yield* p.call("p", todo("p", "p2")); //          [q2, p2]
      yield* q.call("q", todo("q", "q3")); //          [p2, q3]

      const pending = yield* store.pendingMutations;
      expect(titlesOf(pending)).toEqual(["p2", "q3"]);
      expect(idsOf(pending)).toEqual([1, 2]);
      yield* engine.push;
      expect(applied).toEqual(["p2", "q3"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "property: randomized paced traffic with pushes and lost pushes always drains without a gap",
    () =>
      Effect.gen(function* () {
        const { engine, store, applied, mode } = yield* setupLossy;
        const debounced = yield* Paced.debounce(engine, "todo/set", Duration.millis(30));
        const throttled = yield* Paced.throttle(engine, "todo/set", Duration.millis(30));
        const coalesced = yield* Paced.coalesce(engine, "todo/set");
        const strategies = [debounced, throttled, coalesced];

        // Deterministic PRNG, as in paced.test.ts (no new dependency).
        let seed = 249_001;
        const next = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed / 0x7fffffff;
        };
        const lastCall = new Map<string, string>();
        const gapFailures: Array<string> = [];

        for (let round = 0; round < 400; round++) {
          const which = Math.floor(next() * strategies.length);
          const strategy = strategies[which]!;
          // Keys are per strategy: a debounce buffer and a coalescer racing on
          // one key is a different (caller-visible) ordering question than
          // the gap-free journal this property is about.
          const key = `s${which}k${Math.floor(next() * 4)}`;
          const title = `${key}-r${round}`;
          yield* strategy.call(key, todo(key, title));
          lastCall.set(key, title);
          if (next() < 0.3) yield* TestClock.adjust(Duration.millis(10));

          const roll = next();
          if (roll < 0.15) {
            // A healthy push.
            const exit = yield* Effect.exit(engine.push);
            if (Exit.isFailure(exit)) gapFailures.push(String(exit.cause));
          } else if (roll < 0.25) {
            // The server applies the push but the client never hears back.
            yield* Ref.set(mode, next() < 0.5 ? "response-lost" : "request-lost");
            yield* Effect.exit(engine.push);
            yield* Ref.set(mode, "ok");
          }

          // The invariant that makes the journal drainable: contiguous ids,
          // in journal order, at every step.
          const ids = idsOf(
            (yield* store.pendingMutations).filter((m) => m.clientId === "client-a")
          );
          for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1]! + 1);
        }

        yield* TestClock.adjust(Duration.seconds(1)); // flush every debounce/throttle buffer
        yield* engine.push;

        expect(gapFailures).toEqual([]);
        expect(yield* store.pendingMutations).toEqual([]);
        // Nothing lost: the last value called for every key is the last the
        // server applied for it, and nothing was applied twice in a row.
        for (const [key, title] of lastCall) {
          expect(applied.filter((t) => t.startsWith(`${key}-`)).at(-1)).toBe(title);
        }
        expect(new Set(applied).size).toBe(applied.length);
      }).pipe(Effect.scoped),
    30_000
  );
});

const stale = (mutationId: number): Mutation => ({
  clientId: "client-a",
  mutationId,
  mutator: "todo/set",
  args: todo(`t${mutationId}`, `old${mutationId}`),
  createdAt: 0,
});

describe("a committed compaction is never lost to a failure or an interrupt (#249 review B1)", () => {
  /**
   * A durable (KeyValueStore-backed) client store whose backing KVS can be
   * made to fail every write once the compaction intent has landed (an
   * IndexedDB quota error or aborted transaction mid-apply), and to run a hook
   * right after the intent lands (to interrupt the caller there).
   */
  const faultyDurable = Effect.gen(function* () {
    const data = new Map<string, string>();
    const fault = {
      failAfterIntent: false,
      failing: false,
      afterIntent: Effect.void as Effect.Effect<void>,
    };
    const broken = (method: string, key: string) =>
      Effect.fail(new KeyValueStore.KeyValueStoreError({ message: "injected", method, key }));
    const kvs = KeyValueStore.makeStringOnly({
      get: (key) => Effect.sync(() => data.get(key)),
      set: (key, value) =>
        fault.failing
          ? broken("set", key)
          : Effect.sync(() => void data.set(key, value)).pipe(
              Effect.andThen(
                key.endsWith("compactionIntent")
                  ? Effect.sync(() => {
                      if (fault.failAfterIntent) fault.failing = true;
                    }).pipe(Effect.andThen(fault.afterIntent))
                  : Effect.void
              )
            ),
      remove: (key) =>
        fault.failing ? broken("remove", key) : Effect.sync(() => void data.delete(key)),
      clear: Effect.sync(() => data.clear()),
      size: Effect.sync(() => data.size),
    });
    const store = yield* ClientStoreModule.makeKeyValue().pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, kvs)
    );
    return { store, fault };
  });

  const durableSetup = Effect.gen(function* () {
    const { handler, applied } = yield* makeLoggingServer;
    const transport = yield* makeInMemory(handler, "group-a");
    const { store, fault } = yield* faultyDurable;
    const engine = yield* makeEngine(transport, store);
    yield* engine.subscribe(allTodos);
    return { engine, store, fault, applied };
  });

  it.effect("an apply failure after the commit point does not lose the newest paced write", () =>
    Effect.gen(function* () {
      const { engine, store, fault, applied } = yield* durableSetup;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      yield* paced.call("k", todo("k", "e1"));

      // The intent lands, then every write fails: applying it errors.
      fault.failAfterIntent = true;
      yield* paced.call("k", todo("k", "e2")); // commits e1 -> dropped, e2 -> id 1
      expect(fault.failing).toBe(true);
      fault.failAfterIntent = false;
      fault.failing = false;

      // The engine and the Paced tracker saw the renumbering even though the
      // store had not finished writing it; this call must supersede e2, not
      // be mistaken for it.
      yield* paced.call("k", todo("k", "e3"));
      const pending = yield* store.pendingMutations;
      expect(titlesOf(pending)).toEqual(["e3"]);
      expect(idsOf(pending)).toEqual([1]);

      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied).toEqual(["e3"]);
    }).pipe(Effect.scoped)
  );

  it.effect("handles follow a renumbering the store had not finished applying", () =>
    Effect.gen(function* () {
      const { engine, store, fault, applied } = yield* durableSetup;
      const a = yield* engine.mutateWithAck("todo/set", todo("a", "a1"));
      const b = yield* engine.mutateWithAck("todo/set", todo("b", "b1"));
      const aOutcome = yield* Effect.forkChild(Effect.exit(a.acknowledged));

      fault.failAfterIntent = true;
      const result = yield* engine.dropIfPending([a.mutationId]);
      expect(result).toEqual({ dropped: [1], renumbered: [{ from: 2, to: 1 }] });
      fault.failAfterIntent = false;
      fault.failing = false;

      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      expect(applied).toEqual(["b1"]);
      // The applied entry's handle settles as applied; the dropped one does not
      // masquerade as applied.
      expect(yield* b.acknowledged).toEqual({ _tag: "applied" });
      expect(Exit.isFailure(yield* Fiber.join(aOutcome))).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "dropIfPending itself survives an interrupt between the store commit and the re-key",
    () =>
      Effect.gen(function* () {
        const { engine, store, fault, applied } = yield* durableSetup;
        const a = yield* engine.mutateWithAck("todo/set", todo("a", "a1"));
        const b = yield* engine.mutateWithAck("todo/set", todo("b", "b1"));

        const durable = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        fault.afterIntent = Deferred.succeed(durable, undefined).pipe(
          Effect.andThen(Deferred.await(interrupted))
        );
        // Called directly, so no Paced wrapper can mask the engine's own window.
        const caller = yield* Effect.forkChild(engine.dropIfPending([a.mutationId]));
        yield* Deferred.await(durable);
        yield* Effect.forkChild(Fiber.interrupt(caller));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(interrupted, undefined);
        yield* Fiber.await(caller);
        fault.afterIntent = Effect.void;

        // The store renumbered b to id 1, and the engine followed regardless:
        // b's handle and state are keyed by the new id, not left on 2.
        expect(idsOf(yield* store.pendingMutations)).toEqual([1]);
        const states = yield* Stream.runHead(engine.mutationStates);
        const map = states._tag === "Some" ? states.value : HashMap.empty();
        expect(Option.getOrUndefined(HashMap.get(map, 1))).toMatchObject({
          phase: "pending",
          args: { title: "b1" },
        });
        yield* engine.push;
        expect(applied).toEqual(["b1"]);
        expect(yield* b.acknowledged).toEqual({ _tag: "applied" });
      }).pipe(Effect.scoped)
  );

  it.effect("the memory store's compaction cannot be interrupted between journal and counter", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      for (let n = 1; n <= 3; n++) {
        const id = yield* store.nextMutationId("client-a");
        yield* store.appendMutation({ ...stale(id), mutator: "todo/set" });
      }
      const caller = yield* Effect.forkChild(store.compactPending("client-a", [1]));
      // The fork runs the compaction up to its internal yield point (journal
      // renumbered, counter not yet); interrupt it right there.
      yield* Effect.forkChild(Fiber.interrupt(caller));
      yield* Fiber.await(caller);

      // Journal and counter agree: the next id continues the journal.
      expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2]);
      expect(yield* store.nextMutationId("client-a")).toBe(3);
    })
  );

  it.effect("an interrupt between the store commit and the re-key loses nothing", () =>
    Effect.gen(function* () {
      const { engine, store, fault, applied } = yield* durableSetup;
      const paced = yield* Paced.coalesce(engine, "todo/set");
      yield* paced.call("k", todo("k", "e1"));

      const durable = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      fault.afterIntent = Deferred.succeed(durable, undefined).pipe(
        Effect.andThen(Deferred.await(interrupted))
      );
      const caller = yield* Effect.forkChild(paced.call("k", todo("k", "e2")));
      yield* Deferred.await(durable);
      // The interrupt arrives while the store has committed but the engine
      // and trackers have not yet caught up.
      yield* Effect.forkChild(Fiber.interrupt(caller));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(interrupted, undefined);
      yield* Fiber.await(caller);
      fault.afterIntent = Effect.void;

      yield* paced.call("k", todo("k", "e3"));
      const pending = yield* store.pendingMutations;
      expect(titlesOf(pending)).toEqual(["e3"]);
      expect(idsOf(pending)).toEqual([1]);
      yield* engine.push;
      expect(applied).toEqual(["e3"]);
    }).pipe(Effect.scoped)
  );
});

describe("entries from before this session are never renumbered (#249 review N3)", () => {
  it.effect("an engine booted over a persisted journal freezes it", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeLoggingServer;
      const transport = yield* makeInMemory(handler, "group-a");
      // A journal left by an earlier session or a release with no sent
      // watermark: its entries may well have been pushed already.
      const store = yield* ClientStoreModule.makeMemory;
      yield* store.appendMutation(stale(1));
      yield* store.appendMutation(stale(2));
      yield* store.nextMutationId("client-a");
      yield* store.nextMutationId("client-a");
      const engine = yield* makeEngine(transport, store);

      yield* engine.mutate("todo/set", todo("n", "new"));
      expect(yield* engine.dropIfPending([1, 2])).toEqual({ dropped: [], renumbered: [] });
      // This session's own entry is still compactable.
      expect((yield* engine.dropIfPending([3])).dropped).toEqual([3]);
      expect(idsOf(yield* store.pendingMutations)).toEqual([1, 2]);
    }).pipe(Effect.scoped)
  );

  it.effect("hydrating a snapshot's journal freezes it", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      yield* Hydration.hydrate(store, { rows: [], journal: [stale(1), stale(2)] });
      expect(yield* store.compactPending("client-a", [1, 2])).toEqual({
        dropped: [],
        renumbered: [],
      });
    })
  );
});
