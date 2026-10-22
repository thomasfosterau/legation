/**
 * Pull-carried rejections (#365). A permanent rejection is bumped into the
 * client's watermark, so a pull covering it would otherwise settle it as
 * applied. A pull therefore carries the rejections its watermark covers, and
 * the client settles those entries as rejected before it acknowledges the
 * rest. These tests cover the lost push response that leaves a rejection
 * unknown to the client, and the server's pull response that tells it.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

const push = (handler: ServerHandler, group: string, mutations: PushRequest["mutations"]) =>
  handler.handlePush({ clientGroupId: group, mutations }) as Effect.Effect<PushResponse>;

describe("SyncServer pull carries the rejections its watermark covers (#365)", () => {
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

  it.effect("leaves out a rejection above the pull's watermark", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      // The group remembers a rejection for id 5, which this pull's watermark (id 1) does not cover yet.
      const ahead: Backend = {
        ...backend,
        rejections: () => Effect.succeed([{ clientId, mutationId: 5, reason: "not yet covered" }]),
      };
      const handler = yield* serverFor(ahead);
      yield* push(handler, groupId, [
        { clientId, mutationId: 1, mutator: "todo/set", args: { id: "y" }, createdAt: 0 },
      ]);

      const pulled = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(pulled.lastMutationIds).toEqual({ [clientId]: 1 });
      expect(pulled.rejected).toBeUndefined();
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

describe("a pull settles only its own client's rejections in a group (#365)", () => {
  it.effect("a pull lists another client's covered rejection, and this client ignores it", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      const handler = yield* serverFor(backend);
      const otherClient = "client-b";
      const reason = "permission revoked";

      // Client B's rejected push: its own response reports the rejection.
      const storeB = yield* ClientStoreModule.makeMemory;
      const transportB = yield* makeInMemory(handler, groupId);
      const engineB = yield* ClientEngineModule.make({
        clientId: otherClient,
        clientGroupId: groupId,
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, storeB),
        Effect.provideService(ClientTransport, transportB)
      );
      yield* engineB.subscribe(allTodos);
      const handleB = yield* engineB.mutateWithAck("todo/forbidden", {
        id: "x",
        title: "doomed",
        done: false,
      });
      yield* engineB.push;
      expect(yield* handleB.acknowledged).toEqual({ _tag: "rejected", reason });

      // Client A (id 1 is its own, applied) loses the push response, so it stays pending.
      const storeA = yield* ClientStoreModule.makeMemory;
      const lose = yield* Ref.make(false);
      const transportA = yield* makeInMemory(handler, groupId);
      const engineA = yield* ClientEngineModule.make({
        clientId,
        clientGroupId: groupId,
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, storeA),
        Effect.provideService(ClientTransport, lossyPush(transportA, lose))
      );
      yield* engineA.subscribe(allTodos);
      const handleA = yield* engineA.mutateWithAck("todo/set", {
        id: "y",
        title: "kept",
        done: false,
      });
      yield* Ref.set(lose, true);
      expect(Exit.isFailure(yield* Effect.exit(engineA.push))).toBe(true);
      expect(yield* stateOf(engineA, 1)).toMatchObject({ phase: "pending" });

      // The pull from A lists B's rejection, since the group's watermark covers it.
      const pulled = yield* handler.handlePull({
        clientGroupId: groupId,
        subscriptions: [allTodos],
      });
      expect(pulled.lastMutationIds).toEqual({ [clientId]: 1, [otherClient]: 1 });
      expect(pulled.rejected).toEqual([{ clientId: otherClient, mutationId: 1, reason }]);

      // A settles its own id 1 as applied, and B's entry leaves A's states alone.
      yield* Ref.set(lose, false);
      yield* engineA.pull;
      expect(yield* handleA.acknowledged).toEqual({ _tag: "applied" });
      expect(yield* stateOf(engineA, 1)).toMatchObject({ phase: "acknowledged" });
      expect(yield* storeA.pendingMutations).toEqual([]);
    })
  );
});
