/**
 * Introspection over the mirror seam (#136): a host given its store serves
 * the `introspect/*` request kinds, and `Introspection.fromMirror` reads the
 * same subscriptions, journal, cookie, collections, sync failures and events
 * as `Introspection.make` over the host's engine and store. A host without a
 * store does not serve them.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngine from "../ClientEngine.js";
import * as ClientStore from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import { TransportError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as Introspection from "../Introspection.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mirror from "../Mirror.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Transport from "../Transport.js";

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

/** A host engine on `transport` of its own, served with its store, and a mirror of it. */
const setup = (
  wrap: (transport: Transport.ClientTransport) => Transport.ClientTransport = (transport) =>
    transport
) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(backendHandlers);
    const handler = yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
    const store = yield* ClientStore.makeMemory;
    const transport = wrap(yield* Transport.makeInMemory(handler, "group-a"));
    const engine = yield* ClientEngine.make({
      clientId: "host-a",
      clientGroupId: "group-a",
      mutators,
      retry: { pull: Schedule.recurs(0) },
      syncLoop: { pullInterval: Duration.millis(20) },
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    const pair = yield* MirrorChannel.makeLoopbackPair;
    yield* EngineHost.run({ channel: pair.host, engine, store });
    const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
    return {
      engine,
      owned: Introspection.make(engine, store),
      remote: Introspection.fromMirror(mirror),
    };
  });

/** Every point-in-time read of a view, in one record. */
const read = <E>(view: Introspection.EngineIntrospection<E>) =>
  Effect.all(
    {
      subscriptions: view.subscriptions,
      journal: view.journal,
      cookie: view.cookie,
      collections: view.collections,
      syncFailures: view.syncFailures,
    },
    { concurrency: 1 }
  );

describe("Introspection.fromMirror (#136)", () => {
  it.effect("reads what Introspection.make reads over the host's engine and store", () =>
    Effect.gen(function* () {
      const { engine, owned, remote } = yield* setup();
      yield* engine.subscribe(allTodos);
      yield* engine.mutate(setTodo.name, { id: "1", title: "pushed" });
      yield* engine.push;
      yield* engine.pull;
      yield* engine.mutate(setTodo.name, { id: "2", title: "pending" });

      const expected = yield* read(owned);
      expect(expected.journal.map((mutation) => mutation.mutationId)).toEqual([2]);
      expect(expected.cookie).toBeDefined();
      expect(expected.collections).toEqual(["todos"]);
      expect(yield* read(remote)).toEqual(expected);
    })
  );

  it.effect("reads an undefined cookie before the first pull", () =>
    Effect.gen(function* () {
      const { remote } = yield* setup();
      expect(yield* remote.cookie).toBeUndefined();
    })
  );

  it.live("follows the host's engine events", () =>
    Effect.gen(function* () {
      const { engine, remote } = yield* setup();
      const first = yield* Effect.forkChild(Stream.runHead(remote.events));
      // Let the host's handler subscribe to the engine's events first.
      yield* Effect.sleep(Duration.millis(50));
      yield* engine.mutate(setTodo.name, { id: "1", title: "t" });
      const event = yield* Fiber.join(first).pipe(Effect.timeout(Duration.seconds(2)));
      expect(event).toMatchObject({ value: { _tag: "MutationJournaled", mutationId: 1 } });
    })
  );

  it.live("reads the host's sync failures, their errors decoded", () =>
    Effect.gen(function* () {
      const { engine, owned, remote } = yield* setup((transport) => ({
        ...transport,
        pull: () => Effect.fail(new TransportError({ message: "down" })),
      }));
      yield* engine.subscribe(allTodos);
      // `runSync` forks its pull loops into the scope it is given, so interrupting a fibre that
      // ran it stops nothing: the periodic pull would keep failing, and recording, while the two
      // reads below ran. Give it a scope of its own and close it, which interrupts and awaits
      // every loop, so no failure is recorded after the wait and both reads see the same set.
      const syncScope = yield* Scope.make();
      yield* Scope.provide(engine.runSync, syncScope);
      yield* owned.syncFailures.pipe(
        Effect.repeat({
          until: Arr.isReadonlyArrayNonEmpty,
          schedule: Schedule.spaced(Duration.millis(10)),
        })
      );
      yield* Scope.close(syncScope, Exit.void);
      const failures = yield* remote.syncFailures;
      const ownedFailures = yield* owned.syncFailures;
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures).toEqual(ownedFailures);
      expect(failures[0]?.error).toBeInstanceOf(TransportError);
    })
  );

  it.effect("a host given no store does not serve the introspection kinds", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(backendHandlers);
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, Authorization.policy({})),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );
      const engine = yield* ClientEngine.make({
        clientId: "host-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, yield* ClientStore.makeMemory),
        Effect.provideService(
          Transport.ClientTransport,
          yield* Transport.makeInMemory(handler, "group-a")
        )
      );
      const pair = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: pair.host, engine });
      const mirror = yield* Mirror.make({ channel: pair.mirror, mutators });
      const error = yield* Effect.flip(Introspection.fromMirror(mirror).journal);
      expect(error).toMatchObject({ _tag: "HostRequestError", reason: "UnknownKind" });
    })
  );
});
