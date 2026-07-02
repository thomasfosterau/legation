/**
 * Permanent mutation rejection (issue #35), end to end: a mutation the backend
 * permanently rejects is acknowledged (id bumped) without effects, so it never
 * poisons the queue — the client's optimistic effect for it disappears after
 * the acknowledging push/pull with no app code, and mutations queued behind it
 * still apply.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Scope } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { BackendError, MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

// Both mutators write optimistically on the client; on the backend "todo/set"
// applies and "todo/forbidden" always rejects permanently.
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
    // Write, then reject: proves the staged effect is rolled back.
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

describe("permanent mutation rejection (#35)", () => {
  it.effect("a poison mutation's optimistic effect vanishes; the one behind it applies", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-a");
      const engine = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
      yield* engine.subscribe(allTodos);

      // A doomed write, then a good one queued behind it.
      yield* engine.mutate("todo/forbidden", { id: "x", title: "doomed", done: false });
      yield* engine.mutate("todo/set", { id: "y", title: "kept", done: false });
      // Optimistically both are visible and both are journaled.
      expect((yield* engine.query(allTodos)).map((row) => row.id).toSorted()).toEqual(["x", "y"]);
      expect(yield* store.pendingMutations).toHaveLength(2);

      // Push: the backend rejects x (id bumped, no effect) and applies y. Both
      // ids are acknowledged, so the journal drains without app intervention.
      yield* engine.push;
      expect(yield* store.pendingMutations).toEqual([]);

      // Pull the authoritative state and rebase.
      yield* engine.pull;
      const view = yield* engine.query(allTodos);
      expect(view.map((row) => row.id)).toEqual(["y"]); // x's optimistic effect is gone
      expect((view[0]!.value as Todo).title).toBe("kept");
      // The confirmed row carries a backend version; x never reached the store.
      expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["y"]);
    })
  );

  it.effect("a transient failure still aborts the push and retains the journal", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make({
        "todo/boom": () => Effect.fail(new BackendError({ message: "deadlock" })),
      });
      const cvrStore = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, cvrStore),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-t");
      const boomMutators = Mutator.registry([
        {
          mutator: Mutator.make("todo/boom", Schema.Unknown),
          local: (args, writer) => writer.put("todos", (args as Todo).id, args),
        },
      ]);
      const engine = yield* ClientEngineModule.make({
        clientId: "client-t",
        clientGroupId: "group-t",
        mutators: boomMutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/boom", { id: "z", title: "retry me", done: false });

      // A transient BackendError surfaces as a push failure; the journal is kept
      // so the client can retry (unlike a permanent rejection).
      const exit = yield* Effect.exit(engine.push);
      expect(exit._tag).toBe("Failure");
      expect(yield* store.pendingMutations).toHaveLength(1);
    })
  );
});
