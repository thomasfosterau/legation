/**
 * Tab-mirror tests: a real ClientEngine served by EngineHost, consumed by
 * Mirror — over the loopback pair and over a Node BroadcastChannel.
 * Mirror updates arrive on background fibers, so assertions poll with real
 * timers (clock-independent under the test environment).
 */
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Predicate,
  QueryError,
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
import { Effect, Exit, Fiber, Ref, Schema } from "effect";
import * as BroadcastMirrorChannel from "../BroadcastMirrorChannel.js";

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
  authorId: Schema.optional(Schema.String),
});
type Todo = typeof TodoArgs.Type;

// The node graph the URL-keyed tests (#159) compile against: a todo's
// `author` edge is what a `SubscribeUrl` with `include=author` must pin.
const nodes = Node.registry([
  Node.make("todos", {
    attributes: { title: Schema.String, done: Schema.Boolean, authorId: Schema.String },
    edges: { author: Edge.one("users", { via: "authorId" }) },
  }),
  Node.make("users", { attributes: { name: Schema.String } }),
]);

const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

const allTodos = Subset.make({ collection: "todos" });

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Poll until `read` passes `until`, with a bounded number of attempts. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll, users: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return { engine, store };
});

describe("EngineHost ↔ Mirror (loopback)", () => {
  it.effect("subscribe hydrates; mutate is acked and broadcast optimistically", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      yield* mirror.subscribe(allTodos);
      // The mutate ack means the host journaled it (optimistic write).
      yield* mirror.mutate("todo/set", { id: "1", title: "from the tab", done: false });

      const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["from the tab"]);

      // The journal lives in the host, not the tab.
      expect(yield* store.pendingMutations).toHaveLength(1);
      yield* engine.push;
      yield* engine.pull;
      // Confirmed rows keep flowing to the mirror after the rebase.
      const confirmed = yield* eventually(
        mirror.query(allTodos),
        (current) => current.length === 1
      );
      expect(confirmed.map((row) => (row.value as Todo).title)).toEqual(["from the tab"]);
    })
  );

  it.effect("a second mirror hydrates an already-active subset", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });

      const first = yield* Mirror.make({ channel: mirrorChannel, mutators });
      yield* first.subscribe(allTodos);
      yield* first.mutate("todo/set", { id: "1", title: "before", done: false });
      yield* eventually(first.query(allTodos), (current) => current.length === 1);

      // Loopback broadcasts reach every subscriber on the tab side, so a
      // late mirror on the same channel hydrates from the re-broadcast.
      const second = yield* Mirror.make({ channel: mirrorChannel, mutators });
      yield* second.subscribe(allTodos);
      const rows = yield* eventually(second.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["before"]);
    })
  );

  it.effect("invalid args fail in the tab; host validation errors come back", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      const local = yield* Effect.flip(mirror.mutate("todo/set", { id: 1 }));
      expect(local._tag).toBe("MutatorError");

      const unknown = yield* Effect.flip(mirror.mutate("todo/unknown", {}));
      expect(unknown._tag).toBe("MutatorError");
    })
  );

  it.effect("foreign traffic on the channel is ignored", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      yield* mirrorChannel.post({ some: "other library's message" });
      yield* mirrorChannel.post("not even an object");
      yield* mirror.subscribe(allTodos);
      yield* mirror.mutate("todo/set", { id: "1", title: "still works", done: false });
      yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
    })
  );
});

describe("EngineHost subset refcounting", () => {
  it.effect("keeps a subset until its last tab leaves; disconnect releases it", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const subs = yield* Ref.make(0);
      const unsubs = yield* Ref.make(0);
      // Count engine subscribe/unsubscribe; delegate everything else.
      const counted = {
        ...engine,
        subscribe: (subset) =>
          Ref.update(subs, (n) => n + 1).pipe(Effect.andThen(engine.subscribe(subset))),
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted });
      const one = yield* Mirror.make({ channel: mirrorChannel, mutators });

      // Two tabs share the same subset: one engine subscription.
      yield* one.subscribe(allTodos);
      yield* eventually(Ref.get(subs), (n) => n === 1);
      const two = yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* Mirror.make({ channel: mirrorChannel, mutators });
          yield* second.subscribe(allTodos);
          // No second engine subscription, no teardown while both are present.
          yield* sleepReal(30);
          expect(yield* Ref.get(subs)).toBe(1);
          expect(yield* Ref.get(unsubs)).toBe(0);
          return "scoped";
        })
      );
      expect(two).toBe("scoped");

      // The second tab's scope closed → Disconnect released its hold, but
      // the first tab still holds the subset, so no teardown yet.
      yield* sleepReal(30);
      expect(yield* Ref.get(unsubs)).toBe(0);

      // The last tab explicitly unsubscribes → the engine subscription ends.
      yield* one.unsubscribe(allTodos);
      yield* eventually(Ref.get(unsubs), (n) => n === 1);
    })
  );
});

describe("EngineHost liveness (heartbeat)", () => {
  const liveness = { mirrorTimeout: "60 millis", sweepInterval: "15 millis" } as const;

  // Real clock: heartbeat/sweep run on Effect.sleep, which the TestClock
  // would freeze. `it.live` uses wall time, so the short intervals fire.
  it.live("reclaims a subset from a tab that stops heartbeating", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const unsubs = yield* Ref.make(0);
      const counted = {
        ...engine,
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted, liveness });

      // A "ghost" tab subscribes directly on the channel and never
      // heartbeats — modelling a crashed tab that can't send Disconnect.
      yield* mirrorChannel.post({ _tag: "Subscribe", mirrorId: "ghost", subset: allTodos });

      // The sweep reclaims it once its last-seen passes the timeout.
      yield* eventually(Ref.get(unsubs), (n) => n === 1);
    })
  );

  it.live("keeps a live tab's subset across several sweeps", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const unsubs = yield* Ref.make(0);
      const counted = {
        ...engine,
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted, liveness });
      // A real mirror heartbeats faster than the timeout.
      const mirror = yield* Mirror.make({
        channel: mirrorChannel,
        mutators,
        heartbeatInterval: "15 millis",
      });
      yield* mirror.subscribe(allTodos);
      yield* eventually(mirror.query(allTodos), (current) => current.length === 0);

      // Across several timeout windows the heartbeat keeps it alive.
      yield* Effect.sleep("200 millis");
      expect(yield* Ref.get(unsubs)).toBe(0);
    })
  );
});

describe("EngineHost ↔ Mirror (BroadcastChannel)", () => {
  it.effect("syncs tab to host over a real BroadcastChannel pair", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const name = `legation-test-${Date.now()}`;
      const host = yield* BroadcastMirrorChannel.make(name);
      const mirrorChannel = yield* BroadcastMirrorChannel.make(name);
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      yield* mirror.subscribe(allTodos);
      yield* mirror.mutate("todo/set", { id: "1", title: "broadcast", done: false });
      const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["broadcast"]);
    })
  );
});

describe("Mirror: a forwarded request is never silently lost (#119)", () => {
  it.effect(
    "a mutation orphaned by a dead host fails visibly once a new host announces itself",
    () =>
      Effect.gen(function* () {
        const name = `legation-test-restart-${Date.now()}`;
        const mirrorChannel = yield* BroadcastMirrorChannel.make(name);
        const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });
        yield* mirror.subscribe(allTodos);

        // The first host serves this channel for a while, answering the
        // handshake and one mutation normally, then "dies" — its scope
        // closes, tearing down its channel and background fibers, just like
        // a leader tab closing or crashing.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { engine } = yield* makeEngine;
            const host = yield* BroadcastMirrorChannel.make(name);
            yield* EngineHost.run({ channel: host, engine });
            yield* mirror.mutate("todo/set", { id: "warm", title: "while alive", done: false });
            yield* eventually(mirror.query(allTodos), (rows) => rows.length === 1);
          })
        );

        // Sent after the leader is gone: nobody will ever journal or ack it.
        const orphaned = yield* Effect.forkChild(
          mirror.mutate("todo/set", { id: "orphan", title: "never acked", done: false })
        );
        yield* sleepReal(30);

        // A new host takes over and announces itself — the SECOND HostReady
        // this mirror has ever seen, so the stale request is failed instead
        // of hanging forever.
        const { engine: replacement } = yield* makeEngine;
        const newHost = yield* BroadcastMirrorChannel.make(name);
        yield* EngineHost.run({ channel: newHost, engine: replacement });

        const exit = yield* Effect.exit(Fiber.join(orphaned));
        expect(Exit.isFailure(exit)).toBe(true);
      })
  );

  it.effect("a request still in flight fails once the mirror's own scope closes", () =>
    Effect.gen(function* () {
      const name = `legation-test-orphan-scope-${Date.now()}`;
      // Nobody is listening on this channel at all — the request can never
      // be answered while the mirror is alive.
      const inFlight = yield* Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* BroadcastMirrorChannel.make(name);
          const mirror = yield* Mirror.make({ channel, mutators });
          return yield* Effect.forkChild(
            mirror.mutate("todo/set", { id: "1", title: "orphaned", done: false })
          );
        })
      );
      const exit = yield* Effect.exit(Fiber.join(inFlight));
      expect(Exit.isFailure(exit)).toBe(true);
    })
  );

  it.effect("the host's very first readiness announcement never fails a racing request", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const name = `legation-test-first-ready-${Date.now()}`;
      const mirrorChannel = yield* BroadcastMirrorChannel.make(name);
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      // The mutation is issued before the host's own HostReady necessarily
      // finishes propagating to this mirror — a brand-new host's first
      // handshake must never be mistaken for a restart.
      const outcome = yield* Effect.forkChild(
        mirror.mutate("todo/set", { id: "1", title: "first contact", done: false })
      );
      const host = yield* BroadcastMirrorChannel.make(name);
      yield* EngineHost.run({ channel: host, engine });

      const exit = yield* Effect.exit(Fiber.join(outcome));
      expect(Exit.isSuccess(exit)).toBe(true);
    })
  );
});

// ─── URL-keyed subscriptions (#159, ADR-0029 section 2) ──────────────────────

/**
 * A stand-in for `@legation/jsonapi`'s `JsonApiQuery.urlReads` (this package
 * cannot depend on it, ADR-0006): `/{collection}` with an optional
 * `include=a,b`, canonicalised with the include set sorted.
 */
const stubUrls: Client.UrlReads = {
  parse: (url) =>
    Effect.suspend(() => {
      const { pathname, searchParams } = new URL(url, "http://localhost");
      const collection = pathname.split("/").findLast((s) => s.length > 0) ?? "";
      if (!nodes.nodes.has(collection)) {
        return Effect.fail(
          new QueryError({ message: `Unknown collection: ${collection}`, query: collection })
        );
      }
      const include = searchParams.get("include");
      return Effect.succeed({
        collection,
        ...(include === null
          ? {}
          : {
              include: Object.fromEntries(include.split(",").map((edge) => [edge, true as const])),
            }),
      });
    }),
  canonical: (read) =>
    Effect.succeed(
      `/${read.collection}${
        read.include === undefined
          ? ""
          : `?include=${Object.keys(read.include).toSorted().join(",")}`
      }`
    ),
};

const hashes = (engine: ClientEngine.ClientEngine) =>
  Effect.map(engine.activeSubscriptions, (subs) => subs.map(Subset.hash));
const todosRoot = Subset.hash(allTodos);
const authorWindow = Subset.hash(
  Subset.make({ collection: "users", where: Predicate.isIn("id", ["u1"]) })
);

describe("URL-keyed subscriptions over the mirror channel (#159)", () => {
  it.effect("a page with no Client registers by URL: SubscribeUrl pins root and edge windows", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({
        channel: host,
        engine,
        registry: nodes.collections,
        nodes,
        urls: stubUrls,
      });
      yield* engine.mutate("todo/set", { id: "1", title: "by url", done: false, authorId: "u1" });

      // Nothing but a message on the channel: the host parses, plans and
      // registers under the page's id, exactly as Subscribe + SubscribeRelated.
      yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/todos?include=author" });
      const registered = yield* eventually(hashes(engine), (current) => current.length === 2);
      expect(new Set(registered)).toEqual(new Set([todosRoot, authorWindow]));

      // A URL the host cannot parse registers nothing (and is logged).
      yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/widgets" });
      yield* sleepReal(30);
      expect(yield* hashes(engine)).toHaveLength(2);

      // The same URL, however spelt, releases both windows.
      yield* channel.post({
        _tag: "UnsubscribeUrl",
        mirrorId: "page",
        url: "/api/todos?include=author",
      });
      yield* eventually(hashes(engine), (current) => current.length === 0);
    })
  );

  it.effect("a host without URL reads ignores SubscribeUrl and keeps serving", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/todos" });
      yield* sleepReal(30);
      expect(yield* hashes(engine)).toHaveLength(0);
      const mirror = yield* Mirror.make({ channel, mutators });
      yield* mirror.subscribe(allTodos);
      yield* eventually(hashes(engine), (current) => current.length === 1);
    })
  );

  it.effect(
    "a connected Client subscribes by URL; an edged pin releases without dropping the root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine } = yield* makeEngine;
          const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: host, engine, registry: nodes.collections });
          const client = yield* Client.connect({
            nodes,
            mutations: mutators,
            channel,
            urls: stubUrls,
          });
          yield* client.mutate("todo/set", {
            id: "1",
            title: "pinned",
            done: false,
            authorId: "u1",
          });

          yield* client.subscribe("/todos");
          yield* client.subscribe("/todos?include=author");
          expect(yield* client.subscriptions).toEqual(["/todos", "/todos?include=author"]);
          // The host holds the root once for both pins, plus the author window.
          const registered = yield* eventually(hashes(engine), (current) => current.length === 2);
          expect(new Set(registered)).toEqual(new Set([todosRoot, authorWindow]));
          expect(
            (yield* client.coverageOf({ collection: "todos", include: { author: true } }))._tag
          ).toBe("Covered");

          // Releasing the edged pin drops the author window and nothing else:
          // the plain pin's root survives the relational registration's teardown.
          yield* client.unsubscribe("/todos?include=author");
          yield* eventually(hashes(engine), (current) => current.length === 1);
          expect(yield* hashes(engine)).toEqual([todosRoot]);
          expect(
            (yield* client.coverageOf({ collection: "todos", include: { author: true } }))._tag
          ).toBe("Uncovered");
          expect((yield* client.coverageOf({ collection: "todos" }))._tag).toBe("Covered");

          yield* client.unsubscribe("/todos");
          yield* eventually(hashes(engine), (current) => current.length === 0);
          expect(yield* client.subscriptions).toEqual([]);
        })
      )
  );
});
