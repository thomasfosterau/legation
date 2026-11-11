/**
 * Devtools over the mirror seam (#136): `Devtools.fromMirror` builds the same
 * `DevtoolsCore` from a tab that reaches the host's engine only through a
 * `Mirror` — reads over core's introspection kinds, row counts and actions
 * over this package's own kinds, served once the host is given its store and
 * `Devtools.hostRequests`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@thomasfosterau/legation";
import {
  ClientEngine,
  Cvr,
  EngineHost,
  InvalidationBus,
  Mirror,
  MirrorChannel,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation/internal";
import * as Devtools from "../Devtools.js";

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String });
const setTodo = Mutator.make("todo/set", Todo);
const mutators = Mutator.registry([
  { mutator: setTodo, local: (args, writer) => writer.put("todos", args.id, args) },
]);
const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(setTodo, (args, writer) =>
    Effect.asVoid(writer.put("todos", args.id, args))
  ),
]);
const allTodos = Subset.make({ collection: "todos" });

/** A host engine served over a loopback channel, and a mirror's devtools core of it. */
const setup = (serveDevtools: boolean) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(backendHandlers);
    const handler = yield* SyncServer.make.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
    const store = yield* ClientStore.makeMemory;
    const engine = yield* ClientEngine.make({
      clientId: "host-a",
      clientGroupId: "group-a",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(
        Transport.ClientTransport,
        yield* Transport.makeInMemory(handler, "group-a")
      )
    );
    const pair = yield* MirrorChannel.makeLoopbackPair;
    yield* EngineHost.run({
      channel: pair.host,
      engine,
      store,
      requests: serveDevtools ? Devtools.hostRequests(engine, store) : [],
    });
    const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
    return {
      engine,
      owned: Devtools.make(engine, store),
      remote: Devtools.fromMirror(mirror),
    };
  });

/** Every point-in-time read of a core, in one record. */
const read = (core: Devtools.DevtoolsCore) =>
  Effect.all(
    {
      subscriptions: core.subscriptions,
      cookie: core.cookie,
      collections: core.collections,
      syncFailures: core.syncFailures,
    },
    { concurrency: 1 }
  );

describe("Devtools.fromMirror (#136)", () => {
  it.effect("reads what Devtools.make reads over the host's engine and store", () =>
    Effect.gen(function* () {
      const { engine, owned, remote } = yield* setup(true);
      yield* engine.subscribe(allTodos);
      yield* engine.mutate(setTodo.name, { id: "1", title: "t" });
      yield* engine.push;
      yield* engine.pull;

      const expected = yield* read(owned);
      expect(expected.collections).toEqual([{ name: "todos", rowCount: 1 }]);
      expect(yield* read(remote)).toEqual(expected);
    })
  );

  it.effect("its actions drive the host's engine", () =>
    Effect.gen(function* () {
      const { engine, remote } = yield* setup(true);
      yield* engine.subscribe(allTodos);
      yield* engine.mutate(setTodo.name, { id: "1", title: "t" });

      yield* remote.forcePush;
      yield* remote.forcePull;
      expect(yield* remote.collections).toEqual([{ name: "todos", rowCount: 1 }]);

      yield* remote.clearStore;
      expect(yield* remote.collections).toEqual([]);

      yield* remote.dropSubscription(allTodos);
      expect(yield* engine.activeSubscriptions).toEqual([]);
    })
  );

  it.effect("an action the host does not serve fails with UnknownKind", () =>
    Effect.gen(function* () {
      const { remote } = yield* setup(false);
      const error = yield* Effect.flip(remote.forcePush);
      expect(error).toMatchObject({ _tag: "HostRequestError", reason: "UnknownKind" });
      // The reads are core's, served by any host given its store.
      expect(yield* remote.subscriptions).toEqual([]);
    })
  );
});
