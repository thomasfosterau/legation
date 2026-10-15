/**
 * Pull-carried rejections (#365). A permanent rejection is bumped into the
 * client's watermark, so a pull covering it would otherwise settle it as
 * applied. A pull therefore carries the rejections its watermark covers, and
 * the client settles those entries as rejected before it acknowledges the
 * rest. These tests cover the lost push response that leaves a rejection
 * unknown to the client, and the server's pull response that tells it.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, HashMap, Option, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { MutationRejected, TransportError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { PullResponse, PushRequest, PushResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const groupId = "group-a";
const clientId = "client-a";
const allTodos = Subset.make({ collection: "todos" });

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) =>
    Effect.asVoid(writer.put("todos", (args as { readonly id: string }).id, args)),
  "todo/forbidden": (args, writer) =>
    writer
      .put("todos", (args as { readonly id: string }).id, args)
      .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "permission revoked" })))),
};

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { readonly id: string }).id, args),
  },
  {
    mutator: Mutator.make("todo/forbidden", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { readonly id: string }).id, args),
  },
]);

const serverFor = (backend: Backend) =>
  Effect.gen(function* () {
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

/** The client transport, with one switch: the push still reaches the server, but its response is lost. */
const lossyPush = (inner: ClientTransport, lose: Ref.Ref<boolean>): ClientTransport => ({
  ...inner,
  push: (request: PushRequest) =>
    Effect.gen(function* () {
      const response = yield* inner.push(request);
      if (yield* Ref.get(lose)) {
        return yield* new TransportError({ message: "push response lost" });
      }
      return response;
    }),
});

/** The client's mutation state for one id, read as a snapshot. */
const stateOf = (engine: ClientEngineModule.ClientEngine, mutationId: number) =>
  Stream.runHead(engine.mutationStates).pipe(
    Effect.map((head) =>
      Option.isSome(head) ? Option.getOrUndefined(HashMap.get(head.value, mutationId)) : undefined
    )
  );

const makeLossyEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const handler = yield* serverFor(backend);
  const store = yield* ClientStoreModule.makeMemory;
  const inner = yield* makeInMemory(handler, groupId);
  const lose = yield* Ref.make(false);
  const engine = yield* ClientEngineModule.make({
    clientId,
    clientGroupId: groupId,
    mutators,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, lossyPush(inner, lose))
  );
  yield* engine.subscribe(allTodos);
  return { backend, engine, store, lose };
});

describe("ClientEngine settles a pull-carried rejection (#365)", () => {
  it.effect("a lost push response then a pull settles the rejected mutation as rejected", () =>
    Effect.gen(function* () {
      const { backend, engine, store, lose } = yield* makeLossyEngine;
      const handle = yield* engine.mutateWithAck("todo/forbidden", {
        id: "x",
        title: "doomed",
        done: false,
      });

      // The server commits the rejection, but the client never hears of it.
      yield* Ref.set(lose, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      expect(yield* store.pendingMutations).toHaveLength(1);
      expect(yield* stateOf(engine, 1)).toMatchObject({ phase: "pending" });
      expect(yield* backend.lastMutationIds({ clientGroupId: groupId })).toEqual({ [clientId]: 1 });

      // The pull covers id 1, and carries its rejection.
      yield* Ref.set(lose, false);
      yield* engine.pull;

      expect(yield* handle.acknowledged).toEqual({
        _tag: "rejected",
        reason: "permission revoked",
      });
      expect(yield* stateOf(engine, 1)).toMatchObject({
        phase: "rejected",
        reason: "permission revoked",
      });
      expect(yield* store.pendingMutations).toEqual([]);
      expect(yield* engine.query(allTodos)).toEqual([]);
    })
  );

  it.effect("a lost push response then a pull settles an applied mutation as applied", () =>
    Effect.gen(function* () {
      const { engine, store, lose } = yield* makeLossyEngine;
      const handle = yield* engine.mutateWithAck("todo/set", {
        id: "y",
        title: "kept",
        done: false,
      });

      yield* Ref.set(lose, true);
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);

      yield* Ref.set(lose, false);
      yield* engine.pull;

      expect(yield* handle.acknowledged).toEqual({ _tag: "applied" });
      expect(yield* stateOf(engine, 1)).toMatchObject({ phase: "acknowledged" });
      expect(yield* store.pendingMutations).toEqual([]);
      expect((yield* engine.query(allTodos)).map((row) => (row as { id: string }).id)).toEqual([
        "y",
      ]);
    })
  );
});

describe("SyncServer pull carries the rejections its watermark covers (#365)", () => {
  const push = (handler: ServerHandler, group: string, mutations: PushRequest["mutations"]) =>
    handler.handlePush({ clientGroupId: group, mutations }) as Effect.Effect<PushResponse>;

  it.effect("lists each rejection the watermark covers, with its reason", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      const handler = yield* serverFor(backend);
      yield* push(handler, groupId, [
        { clientId, mutationId: 1, mutator: "todo/forbidden", args: { id: "x" }, createdAt: 0 },
        { clientId, mutationId: 2, mutator: "todo/set", args: { id: "y" }, createdAt: 0 },
      ]);

      const pulled: PullResponse = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(pulled.lastMutationIds).toEqual({ [clientId]: 2 });
      expect(pulled.rejected).toEqual([{ clientId, mutationId: 1, reason: "permission revoked" }]);
    })
  );

  it.effect("omits the list when nothing was rejected", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      const handler = yield* serverFor(backend);
      yield* push(handler, groupId, [
        { clientId, mutationId: 1, mutator: "todo/set", args: { id: "y" }, createdAt: 0 },
      ]);

      const pulled = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(pulled.rejected).toBeUndefined();
    })
  );

  it.effect("does not list a rejection from another client group", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      const handler = yield* serverFor(backend);
      yield* push(handler, "group-b", [
        {
          clientId: "client-b",
          mutationId: 1,
          mutator: "todo/forbidden",
          args: { id: "x" },
          createdAt: 0,
        },
      ]);

      const pulled = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(pulled.rejected).toBeUndefined();
    })
  );

  it.effect("keeps listing a rejection until a push starts past it", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      const handler = yield* serverFor(backend);
      yield* push(handler, groupId, [
        { clientId, mutationId: 1, mutator: "todo/forbidden", args: { id: "x" }, createdAt: 0 },
      ]);

      const first = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      const again = yield* handler.handlePull({
        clientGroupId: groupId,
        cookie: first.cookie,
        subscriptions: [allTodos],
      });
      expect(again.rejected).toEqual([{ clientId, mutationId: 1, reason: "permission revoked" }]);

      // A push whose lowest id is 2 proves the client has seen the outcome of id 1.
      yield* push(handler, groupId, [
        { clientId, mutationId: 2, mutator: "todo/set", args: { id: "y" }, createdAt: 0 },
      ]);
      const later = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(later.rejected).toBeUndefined();
    })
  );
});
