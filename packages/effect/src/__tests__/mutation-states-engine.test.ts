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
import { Duration, Effect, Fiber, HashMap, Option, Ref, Schema, Scope, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as Hydration from "../Hydration.js";
import { MutationRejected, StoreError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as MutationState from "../MutationState.js";
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
        const { dropped } = yield* engine.dropIfPending([1]);
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

  it.effect("a 'dropped' state survives the mirror wire (#249 review N2)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.mutate("todo/set", { id: "1", title: "superseded", done: false });
      yield* engine.mutate("todo/set", { id: "2", title: "kept", done: false });
      yield* engine.dropIfPending([1]);
      const states = yield* snapshot(engine);
      expect(get(states, 1)?.phase).toBe("pending"); // the survivor moved into slot 1

      // A map holding a dropped record must still decode on the tab side;
      // before, the unknown phase made the whole update undecodable and the
      // mirror silently ignored it.
      const message = MirrorProtocol.mutationStatesUpdate(
        MutationState.droppedMany(states, [1], 0)
      );
      const decoded = yield* MirrorProtocol.decodeHostMessage(JSON.parse(JSON.stringify(message)));
      expect(decoded?._tag).toBe("MutationStatesUpdate");
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

/**
 * Subscribes to the engine's lifecycle events now and returns `read`: every event emitted before
 * its call, once it has returned. `Stream.toPull` subscribes on its first pull, so the reader pulls
 * until it sees a `PullCompleted` its own pulls emit, which proves the subscription is live (the
 * same set-up as `openEngineEvents` in memory-backend-atomicity.test.ts). No wall-clock wait.
 */
const openEvents = (engine: ClientEngineModule.ClientEngine) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(engine.engineEvents);
    const seen = yield* Ref.make<ReadonlyArray<ClientEngineModule.EngineEvent>>([]);
    const pullsSeen = Ref.get(seen).pipe(
      Effect.map((events) => events.filter((event) => event._tag === "PullCompleted").length)
    );
    yield* Effect.forkScoped(
      Effect.forever(
        pull.pipe(Effect.flatMap((chunk) => Ref.update(seen, (prior) => [...prior, ...chunk])))
      )
    );
    while ((yield* pullsSeen) === 0) {
      yield* engine.pull;
      yield* Effect.yieldNow;
    }
    return {
      read: Effect.gen(function* () {
        const before = yield* pullsSeen;
        yield* engine.pull;
        while ((yield* pullsSeen) === before) yield* Effect.yieldNow;
        return yield* Ref.get(seen);
      }),
    };
  });

/** A journal entry as a snapshot carries it: the client's own id, so the engine treats it as its own. */
const hydratedEntry = (mutationId: number, mutator: string, args: Todo) => ({
  clientId: "client-a",
  mutationId,
  mutator,
  args,
  createdAt: 456,
});

/** The lifecycle events for one mutation id, in order. */
const eventsFor = (events: ReadonlyArray<ClientEngineModule.EngineEvent>, mutationId: number) =>
  events.flatMap((event) =>
    "mutationId" in event && event.mutationId === mutationId ? [event._tag] : []
  );

describe("hydrated journal entries in a running engine (#358)", () => {
  const todo: Todo = { id: "h", title: "from a snapshot", done: false };

  it.effect(
    "a journal entry hydrated into a running engine is tracked as pending, then acknowledged once",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeEngine(handler, store);
        yield* engine.subscribe(allTodos);
        const events = yield* openEvents(engine);

        yield* Hydration.hydrate(store, {
          rows: [],
          journal: [hydratedEntry(1, "todo/set", todo)],
        });
        expect(get(yield* snapshot(engine), 1)).toEqual({
          mutationId: 1,
          mutator: "todo/set",
          args: todo,
          phase: "pending",
          journaledAt: 456,
        });

        yield* engine.push;
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");
        expect(eventsFor(yield* events.read, 1)).toEqual(["MutationAcknowledged"]);
      })
  );

  it.effect(
    "a hydrated entry the server rejects emits exactly one MutationRejected, and tracked phases hold",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeEngine(handler, store);
        yield* engine.subscribe(allTodos);
        const events = yield* openEvents(engine);

        // An already-tracked entry, acknowledged before the hydrate.
        yield* engine.mutate("todo/set", { id: "local", title: "t", done: false });
        yield* engine.push;
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");

        yield* Hydration.hydrate(store, {
          rows: [],
          journal: [hydratedEntry(2, "todo/forbidden", todo)],
        });
        yield* engine.push;

        const seen = yield* events.read;
        expect(seen.filter((event) => event._tag === "MutationRejected")).toEqual([
          {
            _tag: "MutationRejected",
            clientId: "client-a",
            mutationId: 2,
            reason: "permission revoked",
          },
        ]);
        expect(eventsFor(seen, 2)).toEqual(["MutationRejected"]);

        const states = yield* snapshot(engine);
        expect(get(states, 2)?.phase).toBe("rejected");
        expect(get(states, 2)?.reason).toBe("permission revoked");
        expect(get(states, 1)?.phase).toBe("acknowledged");
      })
  );

  it.effect("a hydrate does not reset an entry the engine already tracks as settled", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", todo);
      yield* engine.push;
      expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");

      // The journal now holds a copy of the already-acknowledged id 1 (a
      // duplicate a snapshot carried) next to a genuinely new entry 2.
      yield* Hydration.hydrate(store, {
        rows: [],
        journal: [hydratedEntry(1, "todo/set", todo), hydratedEntry(2, "todo/set", todo)],
      });
      const afterHydrate = yield* snapshot(engine);
      expect(get(afterHydrate, 1)?.phase).toBe("acknowledged");
      expect(get(afterHydrate, 2)?.phase).toBe("pending");

      yield* engine.push;
      expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");
      expect(get(yield* snapshot(engine), 2)?.phase).toBe("acknowledged");
    })
  );

  it.effect(
    "a persisted entry whose boot-time read failed is tracked at the next push, so its rejection is not silent",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const memory = yield* ClientStoreModule.makeMemory;
        // The journal is unreadable until armed off: the boot read falls back to none.
        const unreadable = yield* Ref.make(true);
        const store = ClientStore.of({
          ...memory,
          pendingMutations: Ref.get(unreadable).pipe(
            Effect.flatMap((refused) =>
              refused
                ? Effect.fail(new StoreError({ message: "journal unreadable" }))
                : memory.pendingMutations
            )
          ),
        });
        yield* memory.appendMutation({
          clientId: "client-a",
          mutationId: 1,
          mutator: "todo/forbidden",
          args: todo,
          createdAt: 789,
        });
        const engine = yield* makeEngine(handler, store);
        expect(get(yield* snapshot(engine), 1)).toBeUndefined();

        yield* Ref.set(unreadable, false);
        const events = yield* openEvents(engine);
        yield* engine.push;

        expect(eventsFor(yield* events.read, 1)).toEqual(["MutationRejected"]);
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("rejected");
      })
  );
});
