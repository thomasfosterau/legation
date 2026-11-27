/**
 * ClientEngine.mutationStates: the keyed, reactive mutation-state map
 * — seeded from the journal at boot, folded from journal/ack/reject
 * regardless of whether a mutation went through `mutate`, `mutateEncoded`, or
 * `mutateWithAck` (the state map must reflect every journaled mutation), and
 * bounded under a mutation storm.
 */
import * as P from "effect/Predicate";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HashMap from "effect/HashMap";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
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
import { defined } from "./defined.js";
import * as Json from "../internal/Json.js";
import { idOf } from "./shapes.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args: Todo, writer) => writer.put("todos", args.id, args),
  },
  {
    mutator: Mutator.make("todo/forbidden", Schema.Unknown),
    local: (args: Todo, writer) => writer.put("todos", args.id, args),
  },
]);

const backendHandlers = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", idOf(args), args)),
  "todo/forbidden": (args, writer) =>
    writer
      .put("todos", idOf(args), args)
      .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "permission revoked" })))),
} satisfies Record<string, MemoryBackend.BackendHandler>;

const makeServer = Effect.fn("makeServer")(function* (): Effect.fn.Return<
  ServerHandler,
  never,
  Scope.Scope
> {
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
  ClientEngineModule.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
    ...options,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideServiceEffect(ClientTransport, makeInMemory(handler, "group-a"))
  );

/** The current mutation-state map: `SubscriptionRef.changes` replays the
 * current value to a fresh subscriber, so a one-shot `runHead` is a snapshot. */
const snapshot = (engine: ClientEngineModule.ClientEngine) =>
  Stream.runHead(engine.mutationStates).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : HashMap.empty()))
  );

const get = (map: MutationState.MutationStateMap, id: number) =>
  Option.getOrUndefined(HashMap.get(map, id));

describe("ClientEngine.mutationStates", () => {
  it.effect("is empty before any mutation is journaled", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      expect(HashMap.size(yield* snapshot(engine))).toBe(0);
    })
  );

  it.effect("seeds pending entries from the journal at boot (reload shows pending intents)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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
      const handler = yield* makeServer();
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "t", done: false });
      const pending = yield* snapshot(engine);
      expect(get(pending, 1)?.phase).toBe("pending");
      expect(get(pending, 1)?.mutator).toBe("todo/set");

      // Not only `mutateWithAck`-registered mutations settle: a plain
      // `mutate` must transition too.
      yield* engine.push;
      const settled = yield* snapshot(engine);
      expect(get(settled, 1)?.phase).toBe("acknowledged");
      expect(get(settled, 1)?.settledAt).toBeDefined();
    })
  );

  it.effect("a plain `mutate` through a rejected mutator settles as rejected with a reason", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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
      const handler = yield* makeServer();
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
      const handler = yield* makeServer();
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store, {
        mutationStateRetention: { maxTerminal: 5 },
      });
      yield* engine.subscribe(allTodos);

      // 50 mutations, each journaled and immediately pushed+acknowledged: a
      // storm of terminal settlements.
      yield* Effect.forEach(
        Arr.range(1, 50),
        (i) =>
          Effect.andThen(
            engine.mutate("todo/set", { id: `t${i}`, title: `t${i}`, done: false }),
            engine.push
          ),
        { concurrency: 1, discard: true }
      );
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

  it.effect("dropIfPending settles the compacted entry as 'dropped', not stuck pending", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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

  it.effect("a 'dropped' state survives the mirror wire", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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
      const decoded = yield* MirrorProtocol.decodeHostMessage(Json.parse(Json.stringify(message)));
      expect(decoded?._tag).toBe("MutationStatesUpdate");
    })
  );

  // Real clock: the collector subscribes to the underlying PubSub on a
  // background fibre, so give it a turn to establish before the mutation
  // publishes (mirrors mutation-outcome.test.ts's `it.live` mutationEvents
  // tests — a TestClock would freeze the settle/join timeout).
  it.live("emits a fresh snapshot on every fold (reactive, not a one-shot read)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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
      expect(HashMap.size(defined(snapshots[0]))).toBe(0); // initial (empty)
      expect(get(defined(snapshots[1]), 1)?.phase).toBe("pending"); // journaled
      expect(get(defined(snapshots[2]), 1)?.phase).toBe("acknowledged"); // settled
    })
  );
});

/** Runs `step` until `done` holds, checking before each step. */
const runUntil = <E, R>(
  done: Effect.Effect<boolean, E, R>,
  step: Effect.Effect<unknown, E, R>
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    if (yield* done) return;
    yield* step;
    yield* runUntil(done, step);
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
      Effect.map((events) => events.filter((event) => P.isTagged(event, "PullCompleted")).length)
    );
    yield* Effect.forkScoped(
      Effect.forever(
        pull.pipe(Effect.flatMap((chunk) => Ref.update(seen, (prior) => [...prior, ...chunk])))
      )
    );
    yield* runUntil(
      Effect.map(pullsSeen, (count) => count !== 0),
      Effect.andThen(engine.pull, Effect.yieldNow)
    );
    return {
      read: Effect.gen(function* () {
        const before = yield* pullsSeen;
        yield* engine.pull;
        yield* runUntil(
          Effect.map(pullsSeen, (count) => count !== before),
          Effect.yieldNow
        );
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

describe("hydrated journal entries in a running engine", () => {
  const todo: Todo = { id: "h", title: "from a snapshot", done: false };

  it.effect(
    "a journal entry hydrated into a running engine is tracked as pending, then acknowledged once",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer();
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

        // A second hydrate of the same entry re-adopts nothing: the id is already tracked.
        yield* Hydration.hydrate(store, {
          rows: [],
          journal: [hydratedEntry(1, "todo/set", todo)],
        });

        yield* engine.push;
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");
        // The same opening as a locally journaled mutation: journaled once, then the outcome.
        expect(eventsFor(yield* events.read, 1)).toEqual([
          "MutationJournaled",
          "MutationAcknowledged",
        ]);
      })
  );

  it.effect(
    "a hydrated entry the server rejects emits exactly one MutationRejected, and tracked phases hold",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer();
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
        expect(seen.filter((event) => P.isTagged(event, "MutationRejected"))).toEqual([
          {
            _tag: "MutationRejected",
            clientId: "client-a",
            mutationId: 2,
            reason: "permission revoked",
          },
        ]);
        expect(eventsFor(seen, 2)).toEqual(["MutationJournaled", "MutationRejected"]);

        const states = yield* snapshot(engine);
        expect(get(states, 2)?.phase).toBe("rejected");
        expect(get(states, 2)?.reason).toBe("permission revoked");
        expect(get(states, 1)?.phase).toBe("acknowledged");
      })
  );

  it.effect("a hydrate does not reset an entry the engine already tracks as settled", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* makeEngine(handler, store);
      yield* engine.subscribe(allTodos);
      const events = yield* openEvents(engine);

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

      // Id 1 was journaled once (by the local mutate) and never re-announced by the duplicate;
      // id 2 is announced once, at adoption, ahead of its outcome.
      const seen = yield* events.read;
      expect(eventsFor(seen, 1)).toEqual(["MutationJournaled", "MutationAcknowledged"]);
      expect(eventsFor(seen, 2)).toEqual(["MutationJournaled", "MutationAcknowledged"]);
    })
  );

  it.effect(
    "a persisted entry whose boot-time read failed is tracked at the next push, so its rejection is not silent",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer();
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

        expect(eventsFor(yield* events.read, 1)).toEqual(["MutationJournaled", "MutationRejected"]);
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("rejected");
      })
  );

  it.effect(
    "a pull that trims a hydrated entry while its adoption read is in flight does not re-track it",
    () =>
      Effect.gen(function* () {
        const handler = yield* makeServer();
        const memory = yield* ClientStoreModule.makeMemory;
        // The first journal read after `armed` is cleared takes its snapshot, then parks until the
        // test releases it. Only `resyncAttachedEngines` runs in that window, so the parked read is
        // the adoption read, and the snapshot still holds id 5 when the pull below trims it.
        const armed = yield* Ref.make(false);
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const trimmed = yield* Ref.make(false);
        const gated = ClientStore.of({
          ...memory,
          pendingMutations: Ref.getAndSet(armed, false).pipe(
            Effect.flatMap((gate) =>
              gate
                ? memory.pendingMutations.pipe(
                    Effect.tap(() =>
                      Deferred.succeed(readStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseRead))
                      )
                    )
                  )
                : memory.pendingMutations
            )
          ),
          acknowledge: (clientId, upTo) =>
            memory.acknowledge(clientId, upTo).pipe(Effect.tap(() => Ref.set(trimmed, true))),
        });

        // A peer under the same client id applies mutations 1..5, so the server reports
        // lastMutationIds["client-a"] = 5 and a pull of `engine` trims every journal entry up to 5.
        const peer = yield* makeEngine(handler, yield* ClientStoreModule.makeMemory);
        yield* Effect.forEach(
          Arr.range(1, 5),
          (id) => peer.mutate("todo/set", { id: String(id), title: "peer", done: false }),
          { concurrency: 1, discard: true }
        );
        yield* peer.push;

        const engine = yield* makeEngine(handler, gated);
        yield* engine.subscribe(allTodos);
        const events = yield* openEvents(engine);
        yield* Ref.set(trimmed, false); // only the pull below is the trim under test

        // Written directly, as `Hydration.hydrate` does, with no engine tracking it yet.
        yield* memory.appendMutation(hydratedEntry(5, "todo/set", todo));
        yield* Ref.set(armed, true);
        const resync = yield* Effect.forkChild(ClientEngineModule.resyncAttachedEngines(gated));
        yield* Deferred.await(readStarted);

        const pull = yield* Effect.forkChild(engine.pull);
        // Without the lock the pull trims id 5 now, while the read still holds its snapshot; with
        // it, the pull waits behind the read. Either way it gets a bounded number of scheduler
        // turns (no timers), then the read is released.
        let turn = 0;
        let trimmedSeen = false;
        yield* Effect.whileLoop({
          while: () => turn < 10_000 && !trimmedSeen,
          body: () =>
            Effect.gen(function* () {
              trimmedSeen = yield* Ref.get(trimmed);
              if (!trimmedSeen) yield* Effect.yieldNow;
            }),
          step: () => {
            turn += 1;
          },
        });
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Fiber.join(resync);
        yield* Fiber.join(pull);

        // The journal row is gone, and id 5 is settled by the pull. Never a pending state without
        // a journal row behind it.
        expect(yield* memory.pendingMutations).toEqual([]);
        const states = yield* snapshot(engine);
        expect(get(states, 5)?.phase).toBe("acknowledged");
        expect([...HashMap.values(states)].filter((s) => s.phase === "pending")).toEqual([]);
        expect(eventsFor(yield* events.read, 5)).toEqual([
          "MutationJournaled",
          "MutationAcknowledged",
        ]);
      })
  );

  it.effect(
    "a rejection that contradicts an acknowledgement is logged at warning and ignored",
    () => {
      const warnings: Array<string> = [];
      const logger = Logger.make((options) => {
        if (options.logLevel === "Warn") warnings.push(String(options.message));
      });
      return Effect.gen(function* () {
        const handler = yield* makeServer();
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(handler, "group-a");
        // Once `contradict` is set, every push reports id 1 as permanently rejected, though this
        // client already holds id 1 acknowledged.
        const contradict = yield* Ref.make(false);
        const transport = {
          ...inner,
          push: (request: Parameters<typeof inner.push>[0]) =>
            Effect.zipWith(inner.push(request), Ref.get(contradict), (response, on) =>
              on
                ? {
                    ...response,
                    rejected: [{ clientId: "client-a", mutationId: 1, reason: "late" }],
                  }
                : response
            ),
        };
        const engine = yield* ClientEngineModule.make({
          clientId: "client-a",
          clientGroupId: "group-a",
          mutators,
        }).pipe(
          Effect.provideService(ClientStore, store),
          Effect.provideService(ClientTransport, transport)
        );

        yield* engine.mutate("todo/set", { id: "a", title: "t", done: false });
        yield* engine.push;
        expect(get(yield* snapshot(engine), 1)?.phase).toBe("acknowledged");

        yield* Ref.set(contradict, true);
        yield* engine.mutate("todo/set", { id: "b", title: "t", done: false });
        yield* engine.push;

        const states = yield* snapshot(engine);
        expect(get(states, 1)?.phase).toBe("acknowledged");
        expect(get(states, 1)?.reason).toBeUndefined();
        expect(warnings.filter((message) => message.includes("contradicts"))).toHaveLength(1);
      }).pipe(Effect.withLogger(logger));
    }
  );
});
