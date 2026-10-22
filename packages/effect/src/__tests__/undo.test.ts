/**
 * Undo/redo (issue #46): paired-intents undo layered over any mutate-capable
 * handle. Every undo/redo replays through the handle's `mutate`, so it is
 * optimistic, journaled, rebased, and offline-safe like any mutation — most of
 * these tests exercise that through the MemoryBackend + SyncServer +
 * ClientEngine stack from `engine.test.ts`; one drives the same manager
 * through a `Client` instead, since the two do not share an error channel
 * (issue #223).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as Client from "../Client.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as ClientView from "../ClientView.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { TransportError, VersionNotSupportedError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Undo from "../Undo.js";
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
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
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

/** An engine + a matching undo manager over the given transport. */
const makeManaged = (transport: CT, name: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators: setTodo,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    const manager = yield* Undo.make(engine);
    return { engine, store, manager };
  });

const allTodos = Subset.make({ collection: "todos" });

const titles = (rows: ReadonlyArray<{ readonly value: unknown }>): ReadonlyArray<string> =>
  rows.map((row) => (row.value as Todo).title);

/** The node graph a `Client.make`-built Client reads against. */
const nodes = Node.registry([
  Node.make("todos", { attributes: { title: Schema.String, done: Schema.Boolean } }),
]);

describe("Undo (#46)", () => {
  it.effect("basic undo/redo tracks stacks and a new run clears redo", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const transport = yield* makeInMemory(handler, "group-basic");
      const { engine, manager } = yield* makeManaged(transport, "basic");
      yield* engine.subscribe(allTodos);

      expect(yield* manager.canUndo).toBe(false);
      expect(yield* manager.canRedo).toBe(false);

      // Create, then change the title. The change's undo restores the old title.
      yield* manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "a", done: false } },
        undo: { mutator: "todo/remove", args: { id: "1" } },
      });
      yield* manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "b", done: false } },
        undo: { mutator: "todo/set", args: { id: "1", title: "a", done: false } },
      });
      expect(titles(yield* engine.query(allTodos))).toEqual(["b"]);
      expect(yield* manager.canUndo).toBe(true);
      expect(yield* manager.canRedo).toBe(false);

      // Undo restores the previous title; redo re-applies the change.
      yield* manager.undo;
      expect(titles(yield* engine.query(allTodos))).toEqual(["a"]);
      expect(yield* manager.canRedo).toBe(true);

      yield* manager.redo;
      expect(titles(yield* engine.query(allTodos))).toEqual(["b"]);
      expect(yield* manager.canRedo).toBe(false);

      // Undo, then a fresh run: the redo stack is cleared.
      yield* manager.undo;
      expect(yield* manager.canRedo).toBe(true);
      yield* manager.run({
        execute: { mutator: "todo/set", args: { id: "2", title: "c", done: false } },
        undo: { mutator: "todo/remove", args: { id: "2" } },
      });
      expect(yield* manager.canRedo).toBe(false);

      // Undo past the bottom is a no-op (never an error).
      yield* manager.undo; // drops todo 2
      yield* manager.undo; // drops todo 1
      expect(yield* engine.query(allTodos)).toHaveLength(0);
      expect(yield* manager.canUndo).toBe(false);
      yield* manager.undo; // no-op
      expect(yield* manager.canUndo).toBe(false);
    })
  );

  it.effect("delete-then-undo restores the pre-delete value captured at run time", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const transport = yield* makeInMemory(handler, "group-del");
      const { engine, manager } = yield* makeManaged(transport, "del");
      yield* engine.subscribe(allTodos);

      // A confirmed row to delete: mutate, push, pull.
      yield* engine.mutate("todo/set", { id: "1", title: "keep me", done: true });
      yield* engine.push;
      yield* engine.pull;
      expect(titles(yield* engine.query(allTodos))).toEqual(["keep me"]);

      // Capture the pre-delete value from the local view, then delete with an
      // undo that re-creates exactly that captured row.
      const row = (yield* engine.query(allTodos)).find((r) => r.id === "1")!;
      const captured = row.value as Todo;
      yield* manager.run({
        execute: { mutator: "todo/remove", args: { id: "1" } },
        undo: { mutator: "todo/set", args: captured },
      });
      expect(yield* engine.query(allTodos)).toHaveLength(0);

      // Undo brings the row back with its captured value.
      yield* manager.undo;
      const restored = yield* engine.query(allTodos);
      expect(restored).toHaveLength(1);
      expect(restored[0]!.value).toEqual(captured);
    })
  );

  it.effect("offline undo then reconnect: both flow through journal → push → rebase", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const base = yield* makeInMemory(handler, "group-offline");
      const online = yield* Ref.make(false);
      // A transport that fails push/pull while "offline" (like the demo + the
      // sync-loop tests). Mutations then queue in the journal.
      const gated = <A>(
        effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
      ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
        Ref.get(online).pipe(
          Effect.flatMap((on) =>
            on ? effect : Effect.fail(new TransportError({ message: "offline" }))
          )
        );
      const transport: CT = {
        push: (request) => gated(base.push(request)),
        pull: (request) => gated(base.pull(request)),
        pokes: base.pokes,
        status: base.status,
        statusChanges: base.statusChanges,
      };
      const { engine, store, manager } = yield* makeManaged(transport, "offline");
      yield* engine.subscribe(allTodos);

      // Offline: a create then its undo. Both are optimistic + journaled.
      yield* manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "offline", done: false } },
        undo: { mutator: "todo/remove", args: { id: "1" } },
      });
      expect(titles(yield* engine.query(allTodos))).toEqual(["offline"]);
      yield* manager.undo;
      expect(yield* engine.query(allTodos)).toHaveLength(0);
      // Both mutations sit in the durable journal, visible via the overlay.
      expect(yield* store.pendingMutations).toHaveLength(2);

      // A push while offline fails and leaves the journal intact.
      const offlinePush = yield* Effect.exit(engine.push);
      expect(offlinePush._tag).toBe("Failure");
      expect(yield* store.pendingMutations).toHaveLength(2);

      // Reconnect: push drains the journal, pull rebases. Set-then-remove nets
      // to an empty collection, matching the post-undo local view.
      yield* Ref.set(online, true);
      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);
      yield* engine.pull;
      expect(yield* engine.query(allTodos)).toHaveLength(0);
      expect(yield* store.listRows("todos")).toHaveLength(0);
    })
  );

  it.effect("group coalesces runs into a single undo step", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const transport = yield* makeInMemory(handler, "group-grp");
      const { engine, manager } = yield* makeManaged(transport, "grp");
      yield* engine.subscribe(allTodos);

      const create = (id: string): Undo.UndoEntry => ({
        execute: { mutator: "todo/set", args: { id, title: id, done: false } },
        undo: { mutator: "todo/remove", args: { id } },
      });

      yield* manager.group(
        Effect.all([manager.run(create("a")), manager.run(create("b")), manager.run(create("c"))])
      );
      expect(Arr.sort(titles(yield* engine.query(allTodos)), Order.String)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(yield* manager.canUndo).toBe(true);

      // One undo reverses all three (a single step) and empties the undo stack.
      yield* manager.undo;
      expect(yield* engine.query(allTodos)).toHaveLength(0);
      expect(yield* manager.canUndo).toBe(false);
      expect(yield* manager.canRedo).toBe(true);

      // One redo re-applies all three.
      yield* manager.redo;
      expect(Arr.sort(titles(yield* engine.query(allTodos)), Order.String)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(yield* manager.canUndo).toBe(true);
    })
  );

  it.effect("undo/redo built from a Client, not a ClientEngine (#223)", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const transport = yield* makeInMemory(handler, "group-client");
      const store = yield* ClientStoreModule.makeMemory;
      // The engine is held here only to pull: a pinned read answers locally
      // once a pull has landed (ADR-0029 section 3, #426). `Undo.make` takes
      // the Client itself, not the engine, and infers its error type from
      // `Client.mutate`.
      const engine = yield* ClientEngineModule.make({
        clientId: "client-client",
        clientGroupId: "group-client",
        mutators: setTodo,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
      const client = Client.fromView(nodes, ClientView.fromEngine(engine));
      const manager = yield* Undo.make(client);
      const allTodosRead = { collection: "todos" };
      // Pin the read so `query` answers locally instead of falling through
      // to the (unrelated) server tier — ADR-0025 — and pull it so the pin
      // covers (#426).
      yield* client.subscribe(allTodosRead);
      yield* engine.pull.pipe(Effect.orDie);

      yield* manager.run({
        execute: { mutator: "todo/set", args: { id: "1", title: "a", done: false } },
        undo: { mutator: "todo/remove", args: { id: "1" } },
      });
      expect(titles(yield* client.query(allTodosRead))).toEqual(["a"]);
      expect(yield* manager.canUndo).toBe(true);

      yield* manager.undo;
      expect(yield* client.query(allTodosRead)).toHaveLength(0);
      expect(yield* manager.canRedo).toBe(true);

      yield* manager.redo;
      expect(titles(yield* client.query(allTodosRead))).toEqual(["a"]);
    })
  );
});
