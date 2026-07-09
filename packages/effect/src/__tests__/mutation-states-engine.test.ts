/**
 * ClientEngine.mutationStates (#116): the keyed, reactive mutation-state map
 * — seeded from the journal at boot, folded from journal/ack/reject
 * regardless of whether a mutation went through `mutate`, `mutateEncoded`, or
 * `mutateWithAck` (the previous `mutationEvents` ack/reject events only fired
 * for `mutateWithAck`-registered mutations; #116 fixes that gap since the
 * state map must reflect every journaled mutation), and bounded under a
 * mutation storm.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, HashMap, Option, Schema, Scope, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type * as MutationState from "../MutationState.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

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
  {
    mutator: Mutator.make("todo/forbidden", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/forbidden": (args, writer) =>
    writer
      .put("todos", (args as Todo).id, args)
      .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "permission revoked" })))),
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

const makeEngine = (
  handler: ServerHandler,
  store: ClientStore,
  options?: { readonly mutationStateRetention?: MutationState.RetentionOptions }
) =>
  makeInMemory(handler, "group-a").pipe(
    Effect.flatMap((transport) =>
      ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
        ...options,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      )
    )
  );

/** The current mutation-state map: `SubscriptionRef.changes` replays the
 * current value to a fresh subscriber, so a one-shot `runHead` is a snapshot. */
const snapshot = (engine: ClientEngineModule.ClientEngine) =>
  Stream.runHead(engine.mutationStates).pipe(
    Effect.map((option) => (option._tag === "Some" ? option.value : HashMap.empty()))
  );

const get = (map: MutationState.MutationStateMap, id: number) =>
  Option.getOrUndefined(HashMap.get(map, id));

describe("ClientEngine.mutationStates (#116)", () => {
  it.effect("is empty before any mutation is journaled", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      expect(HashMap.size(yield* snapshot(engine))).toBe(0);
    })
  );

  it.effect("seeds pending entries from the journal at boot (reload shows pending intents)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      // Simulate a reload: append directly to the store's journal before the
      // engine is constructed, as a durable journal would already hold.
      yield* store.appendMutation({
        clientId: "client-a",
        mutationId: 1,
        mutator: "todo/set",
        args: { id: "1", title: "left over", done: false },
        createdAt: 123,
      });

      const engine = yield* makeEngine(handler, store);
      const states = yield* snapshot(engine);
      expect(HashMap.size(states)).toBe(1);
      expect(get(states, 1)).toEqual({
        mutationId: 1,
        mutator: "todo/set",
        args: { id: "1", title: "left over", done: false },
        phase: "pending",
        journaledAt: 123,
      });
    })
  );

  it.effect("a plain `mutate` is tracked as pending, then acknowledged after push", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      const pending = yield* snapshot(engine);
      expect(get(pending, 1)?.phase).toBe("pending");
      expect(get(pending, 1)?.mutator).toBe("todo/set");

      // #116 fixes a gap where only `mutateWithAck`-registered mutations ever
      // settled; a plain `mutate` must transition too.
      yield* engine.push;
      const settled = yield* snapshot(engine);
      expect(get(settled, 1)?.phase).toBe("acknowledged");
      expect(get(settled, 1)?.settledAt).toBeDefined();
    })
  );

  it.effect("a plain `mutate` through a rejected mutator settles as rejected with a reason", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/forbidden", { id: "x", title: "doomed", done: false });
      yield* engine.push;

      const states = yield* snapshot(engine);
      expect(get(states, 1)?.phase).toBe("rejected");
      expect(get(states, 1)?.reason).toBe("permission revoked");
    })
  );

  it.effect("mutateWithAck-journaled mutations are tracked the same way", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const handle = yield* engine.mutateWithAck("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;
      const outcome = yield* handle.acknowledged;
      expect(outcome).toEqual({ _tag: "applied" });

      const states = yield* snapshot(engine);
      expect(get(states, 1)?.phase).toBe("acknowledged");
    })
  );

  it.effect("a mutation storm bounds terminal entries without dropping pending ones", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store, {
        mutationStateRetention: { maxTerminal: 5 },
      });
      yield* engine.subscribe(allTodos);

      // 50 mutations, each journaled and immediately pushed+acknowledged: a
      // storm of terminal settlements.
      for (let i = 1; i <= 50; i++) {
        yield* engine.mutate("todo/set", { id: `t${i}`, title: `t${i}`, done: false });
        yield* engine.push;
      }
      // One more left pending (never pushed) — must survive the bound.
      yield* engine.mutate("todo/set", { id: "last", title: "still pending", done: false });

      const states = yield* snapshot(engine);
      const terminal = [...HashMap.values(states)].filter((s) => s.phase !== "pending");
      const pending = [...HashMap.values(states)].filter((s) => s.phase === "pending");
      expect(terminal.length).toBeLessThanOrEqual(5);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.mutationId).toBe(51);
      // Bounded overall: no unbounded growth across the storm.
      expect(HashMap.size(states)).toBeLessThanOrEqual(6);
    })
  );

  it.effect(
    "dropIfPending (#117 paced compaction) settles the compacted entry as 'dropped', not stuck pending",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeEngine(handler, store);
        yield* engine.subscribe(allTodos);

        yield* engine.mutate("todo/set", { id: "1", title: "superseded", done: false });
        const dropped = yield* engine.dropIfPending([1]);
        expect(dropped).toEqual([1]);

        // The journal no longer has it...
        const pending = yield* store.pendingMutations;
        expect(pending.find((m) => m.mutationId === 1)).toBeUndefined();

        // ...and the state map must not leave it stranded on "pending" forever
        // (the bug this test guards): it settles to "dropped" like any other
        // terminal outcome, so a devtools mutation timeline never shows a
        // phantom in-flight entry for a compacted-away mutation.
        const states = yield* snapshot(engine);
        expect(get(states, 1)?.phase).toBe("dropped");
        expect(get(states, 1)?.settledAt).toBeDefined();
      })
  );

  // Real clock: the collector subscribes to the underlying PubSub on a
  // background fibre, so give it a turn to establish before the mutation
  // publishes (mirrors mutation-outcome.test.ts's `it.live` mutationEvents
  // tests — a TestClock would freeze the settle/join timeout).
  it.live("emits a fresh snapshot on every fold (reactive, not a one-shot read)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      const collected = yield* Effect.forkChild(
        Stream.runCollect(engine.mutationStates.pipe(Stream.take(3)))
      );
      yield* Effect.sleep(Duration.millis(20));
      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      yield* engine.push;

      const snapshots = yield* Fiber.join(collected).pipe(Effect.timeout(Duration.seconds(2)));
      expect(snapshots).toHaveLength(3);
      expect(HashMap.size(snapshots[0]!)).toBe(0); // initial (empty)
      expect(get(snapshots[1]!, 1)?.phase).toBe("pending"); // journaled
      expect(get(snapshots[2]!, 1)?.phase).toBe("acknowledged"); // settled
    })
  );
});
