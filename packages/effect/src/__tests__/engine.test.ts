/**
 * End-to-end engine tests: client mutates optimistically → journal → push →
 * memory backend applies authoritatively → CVR diff → pull patch → rebase.
 */
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { MutationRejected } from "../Errors.js";
import * as Identity from "../Identity.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

// Shared mutator contract; local and backend implementations align here,
// but nothing requires them to (the backend is authoritative).
const setTodo = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => {
      const todo = args as Todo;
      return writer.put("todos", todo.id, todo);
    },
  },
  {
    mutator: Mutator.make("todo/remove", Schema.Unknown),
    local: (args, writer) => writer.del("todos", (args as { id: string }).id),
  },
  {
    // Applies optimistically; the backend always refuses it.
    mutator: Mutator.make("todo/reject", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

// A non-idempotent counter: every application adds one, so a double application
// shows as an extra count. The put-by-id mutators above cannot show it (#286).
interface Counter {
  readonly id: string;
  readonly n: number;
}

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
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
  "todo/reject": () => Effect.fail(new MutationRejected({ reason: "refused by the backend" })),
};

const authPolicy = Authorization.policy({
  todos: Authorization.allowAll,
  counters: Authorization.allowAll,
});

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, authPolicy),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (handler: ServerHandler, name: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, `group-${name}`);
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators: setTodo,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const allTodos = Subset.make({ collection: "todos" });

describe("ClientEngine ↔ SyncServer end to end", () => {
  it.effect("optimistic write → push → pull → confirmed (journal drained)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "write tests", done: false });

      // Optimistic: visible locally before any network.
      const optimistic = yield* engine.query(allTodos);
      expect(optimistic.map((row) => row.id)).toEqual(["1"]);

      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);

      yield* engine.pull;
      const confirmed = yield* store.listRows("todos");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.version).toBe(1);

      // Second pull: CVR makes the patch empty (cookie advanced, same rows).
      const before = yield* store.getCookie;
      yield* engine.pull;
      expect(yield* store.getCookie).not.toBe(before);
      expect(yield* store.listRows("todos")).toHaveLength(1);
    })
  );

  it.effect("a second client group pulls the first group's committed writes", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      const b = yield* makeClient(handler, "b");
      yield* a.engine.subscribe(allTodos);
      yield* b.engine.subscribe(allTodos);

      yield* a.engine.mutate("todo/set", { id: "1", title: "shared", done: false });
      yield* a.engine.push;

      yield* b.engine.pull;
      const seen = yield* b.engine.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["shared"]);
    })
  );

  it.effect("subscriptions narrow by predicate; departed rows are deleted", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      const openOnly = Subset.make({ collection: "todos", where: Predicate.eq("done", false) });
      yield* engine.subscribe(openOnly);

      yield* engine.mutate("todo/set", { id: "1", title: "open", done: false });
      yield* engine.mutate("todo/set", { id: "2", title: "closed", done: true });
      yield* engine.push;
      yield* engine.pull;
      expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["1"]);

      // Completing the open todo removes it from the subscribed subset.
      yield* engine.mutate("todo/set", { id: "1", title: "open", done: true });
      yield* engine.push;
      yield* engine.pull;
      expect(yield* store.listRows("todos")).toEqual([]);
    })
  );

  it.effect("rebase: pending local mutations stay visible over pulled state", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      yield* a.engine.subscribe(allTodos);
      yield* a.engine.mutate("todo/set", { id: "1", title: "v1", done: false });
      yield* a.engine.push;

      // A second pending (unpushed) mutation must survive the pull (rebase).
      yield* a.engine.mutate("todo/set", { id: "2", title: "pending", done: false });
      yield* a.engine.pull;

      const view = yield* a.engine.query(allTodos);
      expect(view.map((row) => row.id).toSorted()).toEqual(["1", "2"]);
      expect(yield* a.store.pendingMutations).toHaveLength(1);
    })
  );

  it.effect("unauthorized collections are denied by default", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(Subset.make({ collection: "secrets" }));
      const result = yield* Effect.exit(engine.pull);
      expect(result._tag).toBe("Failure");
    })
  );
});

describe("mutator args validation", () => {
  const TodoArgs = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    due: Schema.DateFromString,
  });
  const typedMutators = Mutator.registry([
    {
      mutator: Mutator.make("todo/schedule", TodoArgs),
      local: (args, writer) => {
        const todo = args as typeof TodoArgs.Type;
        return writer.put("todos", todo.id, { id: todo.id, dueYear: todo.due.getFullYear() });
      },
    },
  ]);

  const makeTypedClient = Effect.gen(function* () {
    const handler = yield* makeServer;
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-a");
    const engine = yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: typedMutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

  it.effect("rejects args that fail the mutator schema", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeTypedClient;
      const failure = yield* Effect.flip(
        engine.mutate("todo/schedule", {
          id: "1",
          title: 42,
          due: DateTime.toDateUtc(yield* DateTime.now),
        })
      );
      expect(failure._tag).toBe("MutatorError");
      expect(yield* store.pendingMutations).toEqual([]);
    })
  );

  it.effect("journals encoded args and replays handlers with decoded args", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeTypedClient;
      yield* engine.mutate("todo/schedule", {
        id: "1",
        title: "ship",
        due: DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-12T00:00:00.000Z")),
      });

      // The journal holds the wire/persistence form (Date encoded to string).
      const pending = yield* store.pendingMutations;
      expect(pending.map((m) => (m.args as { due: unknown }).due)).toEqual([
        "2026-06-12T00:00:00.000Z",
      ]);

      // Replay decoded the args back to a Date for the handler.
      const view = yield* engine.query(allTodos);
      expect(view.map((row) => row.value)).toEqual([{ id: "1", dueYear: 2026 }]);
    })
  );

  it.effect("rejects unknown mutators", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeTypedClient;
      const failure = yield* Effect.flip(engine.mutate("todo/unknown", {}));
      expect(failure._tag).toBe("MutatorError");
    })
  );
});

/** Real-clock wait: lets a forked observer process the changes published so far. */
const settle = Effect.sleep(Duration.millis(200));

/** Poll until `read` passes `until`, bounded, so a missed change fails rather than hangs. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const titleOf = (
  rows: ReadonlyArray<{ readonly id: string; readonly value: unknown }>,
  id: string
) => (rows.find((row) => row.id === id)?.value as Todo | undefined)?.title;

describe("a push acknowledgement keeps the overlay until a pull reports it (#286)", () => {
  it.live("an observer never sees an acknowledged mutation revert before its pull", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine, store } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "first", done: false });
      yield* engine.push;
      yield* engine.pull;

      const seen = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      yield* Effect.forkScoped(
        Stream.runForEach(engine.observe(allTodos), (rows) =>
          Ref.update(seen, (titles) => [...titles, titleOf(rows, "1")])
        )
      );
      yield* settle;
      expect((yield* Ref.get(seen)).at(-1)).toBe("first");

      yield* engine.mutate("todo/set", { id: "1", title: "edited", done: false });
      yield* eventually(Ref.get(seen), (titles) => titles.at(-1) === "edited");

      // The push acknowledges the edit. The edit stays overlaid, so no emission
      // may show the pre-edit title again.
      yield* engine.push;
      yield* settle;
      const titles = yield* Ref.get(seen);
      expect(titles.slice(titles.indexOf("edited"))).not.toContain("first");
      expect(titleOf(yield* engine.query(allTodos), "1")).toBe("edited");
      expect(yield* store.pendingMutations).toEqual([]);

      // The pull that reports the push reveals the confirmed row.
      yield* engine.pull;
      yield* eventually(Ref.get(seen), (values) => values.at(-1) === "edited");
      expect(titleOf(yield* engine.query(allTodos), "1")).toBe("edited");
      expect(yield* store.pendingMutations).toEqual([]);
      expect(yield* store.listRows("todos")).toHaveLength(1);
    }).pipe(Effect.scoped)
  );

  it.effect("once a pull reports a push, a later write by another client shows through", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const a = yield* makeClient(handler, "a");
      const b = yield* makeClient(handler, "b");
      yield* a.engine.subscribe(allTodos);
      yield* b.engine.subscribe(allTodos);

      yield* a.engine.mutate("todo/set", { id: "1", title: "a's", done: false });
      yield* a.engine.push;
      yield* a.engine.pull;

      // The server now holds B's later write to the same row. A's acknowledged
      // mutation must not be replayed over it: the tail is released by A's pull.
      yield* b.engine.mutate("todo/set", { id: "1", title: "b's", done: false });
      yield* b.engine.push;
      yield* a.engine.pull;
      expect(titleOf(yield* a.engine.query(allTodos), "1")).toBe("b's");
    })
  );

  it.effect("a permanent rejection leaves the view at its push, since nothing was applied", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/reject", { id: "1", title: "refused", done: false });
      expect(titleOf(yield* engine.query(allTodos), "1")).toBe("refused");

      yield* engine.push;
      expect(yield* engine.query(allTodos)).toEqual([]);
    })
  );

  it.effect("an identity reset drops the unpulled tail along with the rows under it", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "signed-in", done: false });
      yield* engine.push;
      expect(yield* engine.query(allTodos)).toHaveLength(1);

      yield* engine.reset("sha256:another-subject" as Identity.Fingerprint);
      expect(yield* engine.query(allTodos)).toEqual([]);
    })
  );

  it.effect(
    "a push past the bound never passes it, nothing reverts, and the next pull restores every row",
    () =>
      Effect.gen(function* () {
        const count = 1100;
        const handler = yield* makeServer;
        const { engine, store } = yield* makeClient(handler, "a");
        yield* engine.subscribe(allTodos);
        for (let i = 0; i < count; i++) {
          yield* engine.mutate("todo/set", { id: String(i), title: `t${i}`, done: false });
        }

        yield* engine.push;
        // The push goes in chunks with a pull between them (#429): the tail is released as it builds, so it
        // never passes the bound, and nothing reverts: every acknowledged effect is still in the view.
        expect((yield* store.unpulled).length).toBeLessThanOrEqual(1024);
        const overlaid = yield* engine.query(allTodos);
        expect(overlaid).toHaveLength(count);
        expect(overlaid.map((row) => row.id)).toContain(String(count - 1));

        yield* engine.pull;
        expect(yield* engine.query(allTodos)).toHaveLength(count);
      })
  );
});

// The counter, as the engine's view shows it: confirmed row plus overlay (#286).
const countersSubset = Subset.make({ collection: "counters" });
const counterValue = (engine: ClientEngineModule.ClientEngine) =>
  engine
    .query(countersSubset)
    .pipe(
      Effect.map((rows) => (rows.find((row) => row.id === "c")?.value as Counter | undefined)?.n)
    );

// A server over `backend`, wired like `makeServer`.
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
const makeCounterEngine = (handler: ServerHandler, store: ClientStore) =>
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

// Commit one increment by another client in the same group. Its watermark entry
// moves and its effect lands on the counter, unseen by the engine under test
// until that engine pulls.
const otherCommit = (handler: ServerHandler, mutationId: number) =>
  handler.handlePush({
    clientGroupId: "group-a",
    mutations: [
      { clientId: "other", mutationId, mutator: "counter/inc", args: { id: "c" }, createdAt: 0 },
    ],
  });

// Parks the first call to one step until the test releases it. `reached` fires
// once the step is parked, so the test can commit or read while it waits.
interface Parking {
  readonly armed: Ref.Ref<boolean>;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeParking = Effect.gen(function* () {
  const parking: Parking = {
    armed: yield* Ref.make(false),
    reached: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  return parking;
});

const parkIfArmed = (parking: Parking) =>
  Effect.gen(function* () {
    if (yield* Ref.getAndSet(parking.armed, false)) {
      yield* Deferred.succeed(parking.reached, undefined);
      yield* Deferred.await(parking.release);
    }
  });

// The pull's backend reads, in order: the watermark, the evaluated view, then
// the rows of the patch. A pull reads the watermark twice, so each parking
// applies to the first call only.
type ReadPoint = "watermark" | "evaluate" | "rows";

// A backend that parks the pull at `at`. For the watermark and evaluate reads it
// parks after the read has returned, so the value it returned is already fixed.
// For the rows read it parks before the rows are fetched.
const parkedBackend = (inner: Backend, at: ReadPoint, parking: Parking): Backend => ({
  ...inner,
  lastMutationIds: (context) =>
    inner
      .lastMutationIds(context)
      .pipe(Effect.tap(() => (at === "watermark" ? parkIfArmed(parking) : Effect.void))),
  evaluate: (context, subset) =>
    inner
      .evaluate(context, subset)
      .pipe(Effect.tap(() => (at === "evaluate" ? parkIfArmed(parking) : Effect.void))),
  getRows: (context, collection, ids) =>
    (at === "rows" ? parkIfArmed(parking) : Effect.void).pipe(
      Effect.andThen(inner.getRows(context, collection, ids))
    ),
});

// Lets a fiber run until it finishes, or the scheduler has run the test 1000
// turns. No wall-clock time: a parked fiber stays unfinished however long it waits.
const runUntilFinishedOrStalled = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000 && fiber.pollUnsafe() === undefined; turn++) {
      yield* Effect.yieldNow;
    }
    return fiber.pollUnsafe();
  });

describe("a push that commits during a pull never double-counts (#286)", () => {
  // The pull's watermark and rows must be one snapshot. A push that commits
  // between them would be in the rows but not the watermark, so the client would
  // keep its entry in the tail and replay it over rows that already hold it.
  for (const at of ["watermark", "evaluate", "rows"] as const) {
    it.effect(`a push committed during the pull's ${at} read is counted once`, () =>
      Effect.gen(function* () {
        const parking = yield* makeParking;
        const inner = yield* MemoryBackend.make(backendHandlers);
        const server = yield* serverOver(parkedBackend(inner, at, parking));
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeCounterEngine(server, store);
        yield* engine.subscribe(countersSubset);

        yield* otherCommit(server, 1);
        yield* engine.pull; // confirmed n = 1
        yield* otherCommit(server, 2); // server n = 2, not yet seen by the engine
        yield* engine.mutate("counter/inc", { id: "c" }); // E, pending: view n = 2
        expect(yield* counterValue(engine)).toBe(2);

        // The pull parks at `at`; E's push commits while it waits. The engine
        // keeps E in its unpulled tail, so its view is still 2.
        yield* Ref.set(parking.armed, true);
        const pulling = yield* Effect.forkChild(engine.pull);
        yield* Deferred.await(parking.reached);
        yield* engine.push; // server n = 3
        expect(yield* counterValue(engine)).toBe(2);

        // The pull reveals the other client's second commit and E: 3, once.
        yield* Deferred.succeed(parking.release, undefined);
        yield* Fiber.join(pulling);
        expect(yield* counterValue(engine)).toBe(3);
        yield* engine.pull;
        expect(yield* counterValue(engine)).toBe(3);
        expect(yield* store.pendingMutations).toEqual([]);
      })
    );
  }
});

describe("a pull's reveal is atomic with its tail release (#286)", () => {
  it.effect("a read between the pull's store commit and its copy update sees the true count", () =>
    Effect.gen(function* () {
      const parking = yield* makeParking;
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const inner = yield* ClientStoreModule.makeMemory;
      // The pull parks after the store has committed its confirmed rows and released the acknowledged
      // tail (one batch on the memory store, #411), before the engine updates its own copy.
      const store: ClientStore = {
        ...inner,
        commitPull: (release) =>
          inner.commitPull!(release).pipe(Effect.andThen(parkIfArmed(parking))),
      };
      const engine = yield* makeCounterEngine(server, store);
      yield* engine.subscribe(countersSubset);

      yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      yield* engine.pull; // confirmed n = 1
      yield* engine.mutate("counter/inc", { id: "c" }); // E pending
      // server n = 2; E is acknowledged into the tail. No read here: the overlay
      // cache stays cold until the parked read below.
      yield* engine.push;

      yield* Ref.set(parking.armed, true);
      const pulling = yield* Effect.forkChild(engine.pull);
      yield* Deferred.await(parking.reached);
      // A read now must not see the new confirmed row with E still replayed over it.
      const reading = yield* Effect.forkChild(counterValue(engine));
      // The read waits on the pull's critical section rather than completing early.
      const early = yield* runUntilFinishedOrStalled(reading);
      expect(early).toBeUndefined();

      yield* Deferred.succeed(parking.release, undefined);
      yield* Fiber.join(pulling);
      expect(yield* Fiber.join(reading)).toBe(2);
      expect(yield* counterValue(engine)).toBe(2);
    })
  );

  it.effect(
    "a pull computed before a push is delivered after its ack keeps that push's overlay",
    () =>
      Effect.gen(function* () {
        const parking = yield* makeParking;
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        // The pull's response is computed, then parked before it reaches the client.
        const delayed: ServerHandler = {
          ...server,
          handlePull: (request) =>
            server.handlePull(request).pipe(Effect.tap(() => parkIfArmed(parking))),
        };
        const store = yield* ClientStoreModule.makeMemory;
        const engine = yield* makeCounterEngine(delayed, store);
        yield* engine.subscribe(countersSubset);

        yield* engine.mutate("counter/inc", { id: "c" });
        yield* engine.push;
        yield* engine.pull; // confirmed n = 1; watermark client-a: 1
        yield* engine.mutate("counter/inc", { id: "c" }); // E2 pending

        yield* Ref.set(parking.armed, true);
        const pulling = yield* Effect.forkChild(engine.pull);
        yield* Deferred.await(parking.reached); // this response reports client-a: 1
        yield* engine.push; // E2 applied on the server and parked in the tail
        expect(yield* counterValue(engine)).toBe(2);

        yield* Deferred.succeed(parking.release, undefined);
        yield* Fiber.join(pulling);
        // E2 is past the response's watermark, so it stays overlaid.
        expect(yield* counterValue(engine)).toBe(2);

        yield* engine.pull;
        expect(yield* counterValue(engine)).toBe(2);
      })
  );
});

describe("a pull's watermark and rows are one snapshot (#286)", () => {
  it.effect("under writes on every pass, the pull never reports less than its rows carry", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(backendHandlers);
      const landings = yield* Ref.make(0);
      // client-a's push lands just after every watermark read, so each pass is
      // disturbed and the pull stops retrying at its bound.
      const landAfterRead = Ref.updateAndGet(landings, (n) => n + 1).pipe(
        Effect.flatMap((mutationId) =>
          inner.applyMutations({ clientGroupId: "group-a" }, [
            {
              clientId: "client-a",
              mutationId,
              mutator: "counter/inc",
              args: { id: "c" },
              createdAt: 0,
            },
          ])
        ),
        Effect.asVoid
      );
      const watermarkReads = yield* Ref.make(0);
      const racing: Backend = {
        ...inner,
        lastMutationIds: (context) =>
          inner
            .lastMutationIds(context)
            .pipe(
              Effect.tap(() =>
                Ref.update(watermarkReads, (n) => n + 1).pipe(Effect.andThen(landAfterRead))
              )
            ),
      };
      const server = yield* serverOver(racing);
      yield* otherCommit(server, 1);

      const response = yield* server.handlePull({
        clientGroupId: "group-a",
        subscriptions: [countersSubset],
      });
      const reported = Object.values(response.lastMutationIds).reduce((sum, upTo) => sum + upTo, 0);
      const counted = response.patch.flatMap((op) =>
        op._tag === "Put" && op.collection === "counters" ? [(op.value as Counter).n] : []
      );
      // The rows may trail the watermark (a transient revert until the next pull),
      // but never carry a push it does not report: that would double-apply.
      expect(counted).toHaveLength(1);
      expect(counted.every((n) => n <= reported)).toBe(true);
      // Three passes, two watermark reads each: the retry bound holds.
      expect(yield* Ref.get(watermarkReads)).toBe(6);
    })
  );

  // The server-side invariant the client relies on: the rows a pull carries hold
  // exactly the pushes its watermark reports. Each push adds one, so the counter
  // in the patch equals the sum of the watermark.
  // `rows` lands just before the patch's rows are fetched; `rows-returned` lands
  // just after, before the closing watermark read (the revert direction: a
  // watermark read only after the rows would report a push they lack).
  for (const at of ["watermark", "evaluate", "rows", "rows-returned"] as const) {
    it.effect(
      `a push landing during the pull's ${at} read is in the patch iff the watermark reports it`,
      () =>
        Effect.gen(function* () {
          const inner = yield* MemoryBackend.make(backendHandlers);
          const landed = yield* Ref.make(false);
          // client-a's push lands once, just after the first call to `at` returns.
          const landOnce = Ref.getAndSet(landed, true).pipe(
            Effect.flatMap((already) =>
              already
                ? Effect.void
                : inner
                    .applyMutations({ clientGroupId: "group-a" }, [
                      {
                        clientId: "client-a",
                        mutationId: 1,
                        mutator: "counter/inc",
                        args: { id: "c" },
                        createdAt: 0,
                      },
                    ])
                    .pipe(Effect.asVoid)
            )
          );
          const racing: Backend = {
            ...inner,
            lastMutationIds: (context) =>
              inner
                .lastMutationIds(context)
                .pipe(Effect.tap(() => (at === "watermark" ? landOnce : Effect.void))),
            evaluate: (context, subset) =>
              inner
                .evaluate(context, subset)
                .pipe(Effect.tap(() => (at === "evaluate" ? landOnce : Effect.void))),
            getRows: (context, collection, ids) =>
              (at === "rows" ? landOnce : Effect.void).pipe(
                Effect.andThen(inner.getRows(context, collection, ids)),
                Effect.tap(() => (at === "rows-returned" ? landOnce : Effect.void))
              ),
          };
          const server = yield* serverOver(racing);
          // Another client commits first, so the racing pull's view holds the counter.
          yield* otherCommit(server, 1);

          const response = yield* server.handlePull({
            clientGroupId: "group-a",
            subscriptions: [countersSubset],
          });
          expect(yield* Ref.get(landed)).toBe(true);
          const reported = Object.values(response.lastMutationIds).reduce(
            (sum, upTo) => sum + upTo,
            0
          );
          const counted = response.patch.flatMap((op) =>
            op._tag === "Put" && op.collection === "counters" ? [(op.value as Counter).n] : []
          );
          expect(counted).toEqual([reported]);
        })
    );
  }
});
