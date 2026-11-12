/**
 * Hydration through the engine host (#146, ADR-0021 amendment §6): the host
 * owns the empty-store gate. Under the engine's pulls it hydrates a snapshot
 * iff the store is empty and no pull has started; otherwise it answers
 * `hydrated: false` with the reason and leaves the store alone. The first of
 * two concurrent snapshots wins, a returning visitor's rows, cookie and
 * journal are untouched, and the first pull after a hydration continues from
 * the snapshot's cookie with no reset. Over the mirror the gate is the
 * `hydrate` request kind; a cold host's `hydrationWindow` holds its pulls for
 * the first snapshot.
 */
import { describe, expect, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngine from "../ClientEngine.js";
import * as ClientStore from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import { TransportError } from "../Errors.js";
import * as Hydration from "../Hydration.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mirror from "../Mirror.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import type { PullRequest, PullResponse } from "../Protocol.js";
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
const nodes = Node.registry([Node.make("todos", { attributes: { title: Schema.String } })]);
const allTodos = Subset.make({ collection: "todos" });
const GROUP = "group-a";

/** One pull the browser engine made: what it sent, and whether the answer was a reset. */
interface Pulled {
  readonly cookie: string | undefined;
  readonly reset: boolean;
}

/** A transport that records each pull it carries. */
const recording = (transport: Transport.ClientTransport, log: Ref.Ref<ReadonlyArray<Pulled>>) =>
  ({
    ...transport,
    pull: (request: PullRequest) =>
      transport.pull(request).pipe(
        Effect.tap((response: PullResponse) =>
          Ref.update(log, (pulls) => [
            ...pulls,
            {
              cookie: request.cookie,
              reset: response.patch.some((op) => P.isTagged(op, "Clear")),
            },
          ])
        )
      ),
  }) satisfies Transport.ClientTransport;

/** A transport whose pulls fail: a pull starts and leaves the store empty. */
const failingPulls = (transport: Transport.ClientTransport): Transport.ClientTransport => ({
  ...transport,
  pull: () => Effect.fail(new TransportError({ message: "offline" })),
});

/**
 * A sync server holding two todos, the snapshot a render of them under
 * `GROUP` produced, and a browser engine (over an empty store) on a recorded
 * transport of the same group.
 */
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
    const writer = yield* ClientEngine.make({
      clientId: "writer",
      clientGroupId: "group-writer",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, yield* ClientStore.makeMemory),
      Effect.provideService(
        Transport.ClientTransport,
        yield* Transport.makeInMemory(handler, "group-writer")
      )
    );
    yield* writer.mutate(setTodo.name, { id: "1", title: "first" });
    yield* writer.mutate(setTodo.name, { id: "2", title: "second" });
    yield* writer.push;

    const snapshot = yield* Hydration.snapshot({
      clientGroupId: GROUP,
      nodes,
      reads: [{ collection: "todos" }],
      transport: yield* Transport.makeInMemory(handler, GROUP),
    });
    const pulls = yield* Ref.make<ReadonlyArray<Pulled>>([]);
    const store = yield* ClientStore.makeMemory;
    const engine = yield* ClientEngine.make({
      clientId: "browser",
      clientGroupId: GROUP,
      mutators,
      retry: { pull: Schedule.recurs(0) },
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(
        Transport.ClientTransport,
        wrap(recording(yield* Transport.makeInMemory(handler, GROUP), pulls))
      )
    );
    return { snapshot, store, engine, pulls };
  });

/** Everything a returning visitor's store holds, for a before/after comparison. */
const contents = (store: ClientStore.ClientStore) =>
  Effect.all(
    {
      rows: store.listRows("todos"),
      cookie: store.getCookie,
      journal: store.pendingMutations,
    },
    { concurrency: 1 }
  );

describe("Hydration.hydrateUnpulled (#146)", () => {
  it.effect("hydrates an empty, unpulled store, and the first pull continues from its cookie", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine, pulls } = yield* setup();
      expect(snapshot.cookie).toBeDefined();
      expect(yield* Hydration.hydrateUnpulled(engine, store, snapshot)).toEqual({
        hydrated: true,
      });
      expect(yield* store.getCookie).toBe(snapshot.cookie);
      // The engine re-synced: its view reads the snapshot's rows.
      expect((yield* engine.query(allTodos)).map((row) => row.id)).toEqual(["1", "2"]);

      yield* engine.subscribe(allTodos);
      yield* engine.pull;
      expect(yield* Ref.get(pulls)).toEqual([{ cookie: snapshot.cookie, reset: false }]);
    })
  );

  it.effect("answers NotEmpty over a returning visitor's store and leaves it untouched", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine } = yield* setup();
      yield* store.putRow("todos", { id: "9", version: 9, value: { id: "9", title: "newer" } });
      yield* store.setCookie("newer-cookie");
      yield* engine.mutate(setTodo.name, { id: "3", title: "journalled offline" });
      const before = yield* contents(store);
      expect(before.journal).toHaveLength(1);

      expect(yield* Hydration.hydrateUnpulled(engine, store, snapshot)).toEqual({
        hydrated: false,
        reason: "NotEmpty",
      });
      expect(yield* contents(store)).toEqual(before);
    })
  );

  it.effect("answers AlreadyPulling once a pull has started, even over an empty store", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine } = yield* setup(failingPulls);
      yield* Effect.flip(engine.pull);
      expect(yield* Hydration.isEmpty(store)).toBe(true);
      expect(yield* Hydration.hydrateUnpulled(engine, store, snapshot)).toEqual({
        hydrated: false,
        reason: "AlreadyPulling",
      });
      expect(yield* Hydration.isEmpty(store)).toBe(true);
    })
  );

  it.effect("of two concurrent snapshots, exactly one hydrates", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine } = yield* setup();
      const other: Hydration.Snapshot = {
        rows: [{ collection: "todos", id: "x", version: 1, value: { id: "x", title: "other" } }],
        cookie: "other-tab",
        journal: [],
      };
      const outcomes = yield* Effect.all(
        [
          Hydration.hydrateUnpulled(engine, store, snapshot),
          Hydration.hydrateUnpulled(engine, store, other),
        ],
        { concurrency: "unbounded" }
      );
      expect(outcomes.filter((outcome) => outcome.hydrated)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.hydrated)).toEqual([
        { hydrated: false, reason: "NotEmpty" },
      ]);
      const won = outcomes[0]?.hydrated ? snapshot : other;
      expect(yield* store.getCookie).toBe(won.cookie);
    })
  );
});

/** A host serving `engine` (with its store, when given one) and a mirror of it. */
const serve = (
  engine: ClientEngine.ClientEngine,
  store: ClientStore.ClientStore | undefined,
  hydrationWindow?: Duration.Input
) =>
  Effect.gen(function* () {
    const pair = yield* MirrorChannel.makeLoopbackPair;
    const channel = pair.host;
    yield* store === undefined
      ? EngineHost.run({ channel, engine })
      : hydrationWindow === undefined
        ? EngineHost.run({ channel, engine, store })
        : EngineHost.run({ channel, engine, store, hydrationWindow });
    return yield* Mirror.make({ channel: pair.mirror, mutators });
  });

describe("the hydrate request kind over the mirror (#146)", () => {
  it.effect("the first snapshot to reach an empty host hydrates it; a later one is NotEmpty", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine } = yield* setup();
      const mirror = yield* serve(engine, store);
      expect(yield* mirror.request(Hydration.requests.hydrate, snapshot)).toEqual({
        hydrated: true,
      });
      expect(yield* store.getCookie).toBe(snapshot.cookie);
      expect(yield* mirror.request(Hydration.requests.hydrate, snapshot)).toEqual({
        hydrated: false,
        reason: "NotEmpty",
      });
    })
  );

  it.effect("a host not given its store does not serve hydration", () =>
    Effect.gen(function* () {
      const { snapshot, engine } = yield* setup();
      const mirror = yield* serve(engine, undefined);
      const error = yield* Effect.flip(mirror.request(Hydration.requests.hydrate, snapshot));
      expect(error.reason).toBe("UnknownKind");
    })
  );

  it.effect("a cold host's hydration window holds its first pull for the snapshot", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine, pulls } = yield* setup();
      const mirror = yield* serve(engine, store, "1 second");
      yield* engine.subscribe(allTodos);
      // The connect pull a sync loop would start: it waits for the hold.
      const pulling = yield* Effect.forkChild(engine.pull);
      expect(yield* mirror.request(Hydration.requests.hydrate, snapshot)).toEqual({
        hydrated: true,
      });
      yield* Fiber.join(pulling);
      expect(yield* Ref.get(pulls)).toEqual([{ cookie: snapshot.cookie, reset: false }]);
    })
  );

  it.effect("the window elapses with no snapshot, and the pulls go ahead", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine, pulls } = yield* setup();
      const mirror = yield* serve(engine, store, "1 second");
      yield* engine.subscribe(allTodos);
      const pulling = yield* Effect.forkChild(engine.pull);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(pulling);
      // No snapshot: the first pull starts the conversation from no cookie.
      expect((yield* Ref.get(pulls)).map((pull) => pull.cookie)).toEqual([undefined]);
      const late = yield* mirror.request(Hydration.requests.hydrate, snapshot);
      expect(late.hydrated).toBe(false);
    })
  );

  it.effect("a returning visitor's host is never held", () =>
    Effect.gen(function* () {
      const { snapshot, store, engine, pulls } = yield* setup();
      yield* store.setCookie("returning");
      const mirror = yield* serve(engine, store, "1 hour");
      yield* engine.subscribe(allTodos);
      yield* engine.pull;
      expect((yield* Ref.get(pulls)).map((pull) => pull.cookie)).toEqual(["returning"]);
      expect(yield* mirror.request(Hydration.requests.hydrate, snapshot)).toEqual({
        hydrated: false,
        reason: "NotEmpty",
      });
    })
  );
});
