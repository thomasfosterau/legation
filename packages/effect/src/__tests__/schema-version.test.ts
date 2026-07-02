/**
 * Schema-version negotiation (#48): the protocol carries an optional
 * `schemaVersion`, the server may reject an unsupported one up front with a
 * typed `VersionNotSupportedError` (never poisoning the journal), the client
 * fires `onUpdateNeeded` exactly once per ongoing rejection, a local
 * `storeVersion` buster clears the cache while preserving the journal, and a
 * fleet cookie-namespace bump forces every old cookie to a reset patch.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Scope } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import { decodePullRequest, decodePushRequest } from "../Protocol.js";
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
    local: (args, writer) => {
      const todo = args as Todo;
      return writer.put("todos", todo.id, todo);
    },
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => {
    const todo = args as Todo;
    return Effect.asVoid(writer.put("todos", todo.id, todo));
  },
};

const authPolicy = Authorization.policy({ todos: Authorization.allowAll });
const allTodos = Subset.make({ collection: "todos" });

/** Provide the four server services around any server-building effect. */
const provideServer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  services: { backend: Backend; cvrStore: Cvr.CvrStore; bus: InvalidationBus.InvalidationBus }
) =>
  effect.pipe(
    Effect.provideService(Backend, services.backend),
    Effect.provideService(Authorization.AuthPolicy, authPolicy),
    Effect.provideService(Cvr.CvrStore, services.cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, services.bus)
  );

const makeServices = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return { backend, cvrStore, bus };
});

const makeServer = (
  options?: SyncServer.SyncServerOptions
): Effect.Effect<ServerHandler, never, Scope.Scope> =>
  makeServices.pipe(
    Effect.flatMap((services) => provideServer(SyncServer.makeWith(options), services))
  );

interface ClientOptions {
  readonly schemaVersion?: string;
  readonly onUpdateNeeded?: (info: {
    schemaVersion?: string;
    message: string;
  }) => Effect.Effect<void>;
}

const makeClient = (handler: ServerHandler, name: string, clientOptions?: ClientOptions) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, `group-${name}`);
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators,
      ...(clientOptions?.schemaVersion !== undefined
        ? { schemaVersion: clientOptions.schemaVersion }
        : {}),
      ...(clientOptions?.onUpdateNeeded !== undefined
        ? { onUpdateNeeded: clientOptions.onUpdateNeeded }
        : {}),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

describe("schema-version rejection", () => {
  it.effect(
    "an unacceptable version fails push and pull typed, fires onUpdateNeeded once, keeps the journal",
    () =>
      Effect.gen(function* () {
        const updates = yield* Ref.make(0);
        const handler = yield* makeServer({ acceptSchemaVersion: (v) => v === "v2" });
        const { engine, store } = yield* makeClient(handler, "a", {
          schemaVersion: "v1",
          onUpdateNeeded: () => Ref.update(updates, (n) => n + 1),
        });
        yield* engine.subscribe(allTodos);

        // A journaled (optimistic) mutation so push has something to send.
        yield* engine.mutate("todo/set", { id: "1", title: "write", done: false });
        expect(yield* store.pendingMutations).toHaveLength(1);

        // Both legs fail with the typed transport-level version error.
        const pushErr = yield* Effect.flip(engine.push);
        expect(pushErr._tag).toBe("VersionNotSupportedError");
        const pullErr = yield* Effect.flip(engine.pull);
        expect(pullErr._tag).toBe("VersionNotSupportedError");

        // A retry storm (repeated push + pull) refires nothing: exactly once for
        // the one ongoing rejection.
        yield* Effect.flip(engine.push);
        yield* Effect.flip(engine.pull);
        expect(yield* Ref.get(updates)).toBe(1);

        // The journal is retained — the intent is not poisoned by the rejection.
        expect(yield* store.pendingMutations).toHaveLength(1);
      })
  );

  it.effect("the version error carries the rejected version", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ schemaVersion?: string; message: string } | undefined>(
        undefined
      );
      const handler = yield* makeServer({ acceptSchemaVersion: (v) => v === "v2" });
      const { engine } = yield* makeClient(handler, "a", {
        schemaVersion: "v1",
        onUpdateNeeded: (info) => Ref.set(seen, info),
      });
      yield* engine.subscribe(allTodos);
      yield* Effect.flip(engine.pull);
      const info = yield* Ref.get(seen);
      expect(info?.schemaVersion).toBe("v1");
    })
  );
});

describe("schema-version interop old ↔ new", () => {
  it.effect("old client (no version) ↔ new server with default accept-all works", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer(); // acceptor unset → accept everything
      const { engine, store } = yield* makeClient(handler, "a"); // no schemaVersion
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "x", done: false });
      yield* engine.push;
      yield* engine.pull;
      expect(yield* store.listRows("todos")).toHaveLength(1);
    })
  );

  it.effect("a configured acceptor rejects the version-less client only when set to", () =>
    Effect.gen(function* () {
      // Rejects undefined (old client).
      const strict = yield* makeServer({ acceptSchemaVersion: (v) => v === "v2" });
      const old = yield* makeClient(strict, "old"); // no schemaVersion
      yield* old.engine.subscribe(allTodos);
      const err = yield* Effect.flip(old.engine.pull);
      expect(err._tag).toBe("VersionNotSupportedError");

      // The same acceptor lets a matching client through.
      const good = yield* makeClient(strict, "good", { schemaVersion: "v2" });
      yield* good.engine.subscribe(allTodos);
      yield* good.engine.mutate("todo/set", { id: "1", title: "x", done: false });
      yield* good.engine.push;
      yield* good.engine.pull;
      expect(yield* good.store.listRows("todos")).toHaveLength(1);
    })
  );

  it.effect("new client (with version) ↔ old server (ignores the field) works", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer(); // no acceptor: ignores schemaVersion
      const { engine, store } = yield* makeClient(handler, "a", { schemaVersion: "v9" });
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "x", done: false });
      yield* engine.push;
      yield* engine.pull;
      expect(yield* store.listRows("todos")).toHaveLength(1);
    })
  );
});

describe("protocol round-trips a version-less request unchanged", () => {
  it.effect("a push/pull request without schemaVersion decodes as today", () =>
    Effect.gen(function* () {
      const push = yield* decodePushRequest({ clientGroupId: "g", mutations: [] });
      expect(push.schemaVersion).toBeUndefined();
      expect(push).toEqual({ clientGroupId: "g", mutations: [] });

      const pull = yield* decodePullRequest({ clientGroupId: "g", subscriptions: [] });
      expect(pull.schemaVersion).toBeUndefined();
      expect(pull).toEqual({ clientGroupId: "g", subscriptions: [] });
    })
  );
});

describe("storeVersion buster", () => {
  it.effect("a changed storeVersion clears rows + cookie but preserves the journal", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue({ storeVersion: "v1" });
      yield* first.putRow("todos", { id: "1", version: 1, value: { title: "cached" } });
      yield* first.setCookie("cookie-1");
      yield* first.appendMutation({
        clientId: "c1",
        mutationId: yield* first.nextMutationId("c1"),
        mutator: "todo/set",
        args: { id: "2", title: "pending", done: false },
        createdAt: 0,
      });

      // Reopen over the same KVS with a bumped storeVersion: rows + cookie go,
      // the journal stays.
      const second = yield* ClientStoreModule.makeKeyValue({ storeVersion: "v2" });
      expect(yield* second.listRows("todos")).toHaveLength(0);
      expect(yield* second.getCookie).toBeUndefined();
      expect(yield* second.pendingMutations).toHaveLength(1);

      // Same version again is a no-op: nothing further is cleared.
      const third = yield* ClientStoreModule.makeKeyValue({ storeVersion: "v2" });
      expect(yield* third.pendingMutations).toHaveLength(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("after a buster the next pull rehydrates fully; the pending intent survives", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();

      // Client A (storeVersion v1) commits a row so the backend holds it.
      const storeA = yield* ClientStoreModule.makeKeyValue({ storeVersion: "v1" });
      const transportA = yield* makeInMemory(handler, "group-a");
      const engineA = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, storeA),
        Effect.provideService(ClientTransport, transportA)
      );
      yield* engineA.subscribe(allTodos);
      yield* engineA.mutate("todo/set", { id: "1", title: "committed", done: false });
      yield* engineA.push;
      yield* engineA.pull;
      expect(yield* storeA.listRows("todos")).toHaveLength(1);
      // Leave an unpushed mutation in the journal before the buster runs.
      yield* engineA.mutate("todo/set", { id: "2", title: "pending", done: false });

      // Reopen the store with a bumped storeVersion → rows + cookie cleared,
      // journal preserved.
      const storeB = yield* ClientStoreModule.makeKeyValue({ storeVersion: "v2" });
      expect(yield* storeB.listRows("todos")).toHaveLength(0);
      expect(yield* storeB.getCookie).toBeUndefined();
      expect(yield* storeB.pendingMutations).toHaveLength(1);

      const transportB = yield* makeInMemory(handler, "group-a");
      const engineB = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, storeB),
        Effect.provideService(ClientTransport, transportB)
      );
      yield* engineB.subscribe(allTodos);
      yield* engineB.pull; // full reset: rehydrates row "1" from the server
      expect(yield* storeB.listRows("todos")).toHaveLength(1);
      // The preserved pending intent ("2") is still visible via the overlay.
      const view = yield* engineB.query(allTodos);
      expect(view.map((row) => row.id).toSorted()).toEqual(["1", "2"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("fleet cookie-reset via CVR namespace bump", () => {
  it.effect("a pull with a pre-bump cookie is a reset patch (Clear present)", () =>
    Effect.gen(function* () {
      const services = yield* makeServices;
      const serverA = yield* provideServer(SyncServer.makeWith({ cookieNamespace: "A" }), services);

      // Commit a row and take a cookie under namespace A.
      yield* serverA.handlePush({
        clientGroupId: "g",
        mutations: [
          {
            clientId: "c",
            mutationId: 1,
            mutator: "todo/set",
            args: { id: "1", title: "x", done: false },
            createdAt: 0,
          },
        ],
      });
      const pull1 = yield* serverA.handlePull({ clientGroupId: "g", subscriptions: [allTodos] });
      const oldCookie = pull1.cookie;
      // First pull (no cookie presented) is not a reset.
      expect(pull1.patch.some((op) => op._tag === "Clear")).toBe(false);

      // Same namespace, known cookie → minimal (empty) patch, no reset.
      const sameNs = yield* serverA.handlePull({
        clientGroupId: "g",
        cookie: oldCookie,
        subscriptions: [allTodos],
      });
      expect(sameNs.patch.some((op) => op._tag === "Clear")).toBe(false);

      // Bump the fleet namespace: a new server over the same CVR + backend now
      // treats the pre-bump cookie as unknown → a reset patch.
      const serverB = yield* provideServer(SyncServer.makeWith({ cookieNamespace: "B" }), services);
      const afterBump = yield* serverB.handlePull({
        clientGroupId: "g",
        cookie: oldCookie,
        subscriptions: [allTodos],
      });
      expect(afterBump.patch.some((op) => op._tag === "Clear")).toBe(true);
      // The reset still re-sends the row as a full put.
      expect(afterBump.patch.some((op) => op._tag === "Put")).toBe(true);
    })
  );
});
