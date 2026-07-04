/**
 * Mirror-protocol extensions (ADR-0021 follow-up): named queries and
 * auto-subscribing relational reads over EngineHost ↔ Mirror. The host
 * owns the server round-trip (named-query registration) and the whole
 * relational read (reconcile loop + join) — tabs receive resolved rows.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  Collection,
  MemoryBackend,
  Mutator,
  Predicate,
  Query,
  Transport,
} from "@legation/effect";
import {
  ClientEngine,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  Subset,
  SyncServer,
  Mirror,
} from "@legation/effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import * as BroadcastMirrorChannel from "../BroadcastMirrorChannel.js";
import * as ServiceWorkerHost from "../ServiceWorkerHost.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly authorId: string;
}
interface User {
  readonly id: string;
  readonly name: string;
}

const todoSet = Mutator.make("todo/set", Schema.Unknown);
const userSet = Mutator.make("user/set", Schema.Unknown);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
  { mutator: userSet, local: (args, writer) => writer.put("users", (args as User).id, args) },
]);

const collections = Collection.registry([
  Collection.make({
    name: "users",
    schema: Schema.Unknown,
    id: (value) => (value as User).id,
  }),
  Collection.make({
    name: "todos",
    schema: Schema.Unknown,
    id: (value) => (value as Todo).id,
    relationships: [
      {
        name: "author",
        kind: "one",
        collection: "users",
        localField: "authorId",
        foreignField: "id",
      },
    ],
  }),
]);

const openTodos = Query.make("todos/open", Schema.Struct({}));
const queries = Query.registry([
  {
    query: openTodos,
    local: () => Subset.make({ collection: "todos", where: Predicate.eq("done", false) }),
  },
]);
const resolver = Query.resolver([
  {
    query: openTodos,
    server: () =>
      Effect.succeed(Subset.make({ collection: "todos", where: Predicate.eq("done", false) })),
  },
]);

const allTodos = Subset.make({ collection: "todos" });

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

// Generous under parallel-suite worker contention; passing runs exit early.
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) =>
        writer.put("todos", (args as Todo).id, args)
      ),
      MemoryBackend.handler(userSet, (args, writer) =>
        writer.put("users", (args as User).id, args)
      ),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll, users: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess),
    Effect.provideService(Query.QueryResolver, resolver)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
    queries,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return engine;
});

describe("EngineHost ↔ Mirror extensions", () => {
  it.effect(
    "a named query registers through the host and mirrors its filtered rows",
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine, registry: collections });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        yield* mirror.subscribeQuery("todos/open", {});
        yield* mirror.mutate("todo/set", { id: "1", title: "open", done: false, authorId: "u1" });
        yield* mirror.mutate("todo/set", { id: "2", title: "closed", done: true, authorId: "u1" });

        // Only the open todo materializes under the named key.
        const rows = yield* eventually(
          mirror.queryNamed("todos/open", {}),
          (current) => current.length === 1
        );
        expect((rows[0]!.value as Todo).title).toBe("open");

        // The named registration reached the server: after a push/pull round
        // trip the confirmed row still renders through the named subset.
        yield* engine.push;
        yield* engine.pull;
        const confirmed = yield* eventually(
          mirror.queryNamed("todos/open", {}),
          (current) => current.length === 1
        );
        expect((confirmed[0]!.value as Todo).done).toBe(false);
      }),
    20_000
  );

  it.effect(
    "related registers through the host; tabs receive resolved joins",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngine;
          const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: host, engine, registry: collections });
          const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

          yield* mirror.mutate("user/set", { id: "u1", name: "Ada" });
          yield* mirror.mutate("todo/set", {
            id: "1",
            title: "join me",
            done: false,
            authorId: "u1",
          });

          const latest = yield* Ref.make<ReadonlyArray<{ related: Record<string, unknown> }>>([]);
          const stream = yield* mirror.related(collections, "todos", allTodos, ["author"]);
          yield* Effect.forkScoped(
            Stream.runForEach(stream, (rows) => Ref.set(latest, rows)).pipe(Effect.ignore)
          );

          // The host computes the join; the tab receives resolved rows.
          const joined = yield* eventually(
            Ref.get(latest),
            (rows) => rows.length === 1 && (rows[0]!.related["author"] as User)?.name === "Ada"
          );
          expect((joined[0]!.related["author"] as User).name).toBe("Ada");

          // A foreign write re-resolves the join without touching the base.
          yield* mirror.mutate("user/set", { id: "u1", name: "Ada Lovelace" });
          yield* eventually(
            Ref.get(latest),
            (rows) => (rows[0]?.related["author"] as User)?.name === "Ada Lovelace"
          );

          // The host's reconcile loop subscribed base + narrowed foreign subsets.
          const subscriptions = yield* engine.activeSubscriptions;
          expect(subscriptions.length).toBeGreaterThanOrEqual(2);
        })
      ),
    20_000
  );

  it.effect(
    "releasing the last related tab tears the host registration down",
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine, registry: collections });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        yield* mirror.mutate("user/set", { id: "u1", name: "Ada" });
        yield* mirror.mutate("todo/set", { id: "1", title: "t", done: false, authorId: "u1" });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* mirror.related(collections, "todos", allTodos, ["author"]);
            yield* Stream.runHead(Stream.take(stream, 1));
            yield* eventually(engine.activeSubscriptions, (subs) => subs.length >= 2);
          })
        );

        // Scope closed → UnsubscribeRelated posted → host released the engine
        // subscriptions the reconcile loop held.
        const remaining = yield* eventually(
          engine.activeSubscriptions,
          (subs) => subs.length === 0
        );
        expect(remaining).toHaveLength(0);
      }),
    20_000
  );
});

describe("Mirror interest ledger", () => {
  it.effect(
    "observing auto-registers the subset and releases it when the stream ends",
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine, registry: collections });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        yield* mirror.mutate("todo/set", { id: "1", title: "auto", done: false, authorId: "u1" });

        // No explicit subscribe anywhere: the observer's stream is the only
        // interest, and it must be enough to hydrate the subset.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const latest = yield* Ref.make<ReadonlyArray<ClientEngine.LocalRow>>([]);
            yield* Effect.forkScoped(
              Stream.runForEach(mirror.observe(allTodos), (rows) => Ref.set(latest, rows)).pipe(
                Effect.ignore
              )
            );
            const rows = yield* eventually(Ref.get(latest), (current) => current.length === 1);
            expect((rows[0]!.value as Todo).title).toBe("auto");
            yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
          })
        );

        // The stream was the last interest: its end releases the registration.
        const remaining = yield* eventually(
          engine.activeSubscriptions,
          (subs) => subs.length === 0
        );
        expect(remaining).toHaveLength(0);
      }),
    20_000
  );

  it.effect(
    "an explicit subscribe pins the subset beyond any observer's lifetime",
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: host, engine, registry: collections });
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

        yield* mirror.subscribe(allTodos);
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);

        // An observer comes and goes. The host refcounts registrations per
        // TAB, so a stray Unsubscribe here would drop the whole claim — the
        // ledger must keep quiet while the explicit pin stands.
        yield* Stream.runHead(Stream.take(mirror.observe(allTodos), 1));

        // Still registered: a later write still reaches the mirror.
        yield* mirror.mutate("todo/set", { id: "1", title: "pinned", done: false, authorId: "u1" });
        const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
        expect((rows[0]!.value as Todo).title).toBe("pinned");
        expect(yield* engine.activeSubscriptions).toHaveLength(1);

        // Releasing the pin (no observers left) drops the registration.
        yield* mirror.unsubscribe(allTodos);
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 0);
      }),
    20_000
  );
});

describe("ServiceWorkerHost", () => {
  it.effect(
    "serves mirrors over its broadcast channel with the registry forwarded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* makeEngine;
          const name = `legation-swh-${Math.random().toString(36).slice(2)}`;
          // The host wires its channel inside the forked fiber; give it a
          // beat before the mirror posts (BroadcastChannel drops unheard
          // messages).
          yield* Effect.forkScoped(
            ServiceWorkerHost.run({ channelName: name, registry: collections }).pipe(
              Effect.provideService(ClientEngine.ClientEngine, engine)
            )
          );
          yield* sleepReal(200);

          const mirrorChannel2 = yield* BroadcastMirrorChannel.make(name);
          const mirror = yield* Mirror.make({ channel: mirrorChannel2, mutators });
          yield* mirror.mutate("user/set", { id: "u1", name: "Ada" });
          yield* mirror.mutate("todo/set", { id: "1", title: "sw", done: false, authorId: "u1" });

          // Registry pass-through: related resolves through the SW host.
          const latest = yield* Ref.make<ReadonlyArray<{ related: Record<string, unknown> }>>([]);
          const stream = yield* mirror.related(collections, "todos", allTodos, ["author"]);
          yield* Effect.forkScoped(
            Stream.runForEach(stream, (rows) => Ref.set(latest, rows)).pipe(Effect.ignore)
          );
          const joined = yield* eventually(
            Ref.get(latest),
            (rows) => rows.length === 1 && (rows[0]!.related["author"] as User)?.name === "Ada"
          );
          expect((joined[0]!.related["author"] as User).name).toBe("Ada");
        })
      ),
    20_000
  );
});

describe("HostReady replay", () => {
  it.effect(
    "a tab that subscribed before the host started hydrates once the host announces",
    () =>
      Effect.gen(function* () {
        const engine = yield* makeEngine;
        const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;

        // The tab races ahead of the host: these registrations go nowhere.
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });
        yield* mirror.subscribe(allTodos);
        yield* mirror.subscribeQuery("todos/open", {});
        yield* sleepReal(50);

        // The host starts late and announces; the tab replays everything.
        yield* EngineHost.run({ channel: host, engine, registry: collections });
        yield* mirror.mutate("todo/set", { id: "1", title: "late", done: false, authorId: "u1" });

        const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
        expect((rows[0]!.value as Todo).title).toBe("late");
        const named = yield* eventually(
          mirror.queryNamed("todos/open", {}),
          (current) => current.length === 1
        );
        expect((named[0]!.value as Todo).done).toBe(false);
      }),
    20_000
  );
});
