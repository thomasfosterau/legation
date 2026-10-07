/**
 * End-to-end engine tests: client mutates optimistically → journal → push →
 * memory backend applies authoritatively → CVR diff → pull patch → rebase.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Scope, Stream } from "effect";
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

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
  "todo/reject": () => Effect.fail(new MutationRejected({ reason: "refused by the backend" })),
};

const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

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
        engine.mutate("todo/schedule", { id: "1", title: 42, due: new Date() })
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
        due: new Date("2026-06-12T00:00:00.000Z"),
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

  it.effect("with no pull, the unpulled tail is bounded and the next pull restores every row", () =>
    Effect.gen(function* () {
      const count = 1100;
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* engine.subscribe(allTodos);
      for (let i = 0; i < count; i++) {
        yield* engine.mutate("todo/set", { id: String(i), title: `t${i}`, done: false });
      }

      yield* engine.push;
      const overlaid = yield* engine.query(allTodos);
      // Past the limit the oldest acknowledged effects leave the overlay; the
      // newest stay, so the tail cannot grow without bound.
      expect(overlaid.length).toBeGreaterThan(0);
      expect(overlaid.length).toBeLessThan(count);
      expect(overlaid.map((row) => row.id)).toContain(String(count - 1));

      yield* engine.pull;
      expect(yield* engine.query(allTodos)).toHaveLength(count);
    })
  );
});

describe("a pull's lastMutationIds never runs ahead of its patch (#286)", () => {
  it.effect("a push that lands while the pull reads its view is not reported by that pull", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(backendHandlers);
      const landed = yield* Ref.make(false);
      // Lands one push after the first subset read, before the pull returns.
      const racing: Backend = {
        ...inner,
        evaluate: (context, subset) =>
          inner.evaluate(context, subset).pipe(
            Effect.tap(() =>
              Ref.getAndSet(landed, true).pipe(
                Effect.flatMap((already) =>
                  already
                    ? Effect.void
                    : inner
                        .applyMutations(context, [
                          {
                            clientId: "client-a",
                            mutationId: 1,
                            mutator: "todo/set",
                            args: { id: "1", title: "raced", done: false },
                            createdAt: 0,
                          },
                        ])
                        .pipe(Effect.asVoid)
                )
              )
            )
          ),
      };
      const server = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, racing),
        Effect.provideService(Authorization.AuthPolicy, authPolicy),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );

      const response = yield* server.handlePull({
        clientGroupId: "group-a",
        subscriptions: [allTodos],
      });
      expect(yield* Ref.get(landed)).toBe(true);
      // The push landed after the view was read, so the response must not
      // report it: a reported id whose effects the patch lacks would be revealed
      // without them.
      const reported = response.lastMutationIds["client-a"] ?? 0;
      expect(reported).toBe(0);
      expect(response.patch.some((op) => op._tag === "Put" && op.id === "1")).toBe(false);
    })
  );
});
