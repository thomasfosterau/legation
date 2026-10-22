/**
 * Tab-mirror tests: a real ClientEngine served by EngineHost, consumed by
 * Mirror — over the loopback pair and over a Node BroadcastChannel.
 * Mirror updates arrive on background fibers, so assertions poll with real
 * timers (clock-independent under the test environment). The liveness cases
 * are the exception: they drive the host's sweep and the mirror's heartbeat
 * on the TestClock (#312).
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
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Coverage,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  Subset,
  SyncServer,
  Mirror,
  ClientView,
} from "@thomasfosterau/legation-effect/internal";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as BroadcastMirrorChannel from "../BroadcastMirrorChannel.js";

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  isDone: Schema.Boolean,
  authorId: Schema.optional(Schema.String),
});
type Todo = typeof TodoArgs.Type;

// The node graph the URL-keyed tests (#159) compile against: a todo's
// `author` edge is what a `SubscribeUrl` with `include=author` must pin.
const nodes = Node.registry([
  Node.make("todos", {
    attributes: { title: Schema.String, isDone: Schema.Boolean, authorId: Schema.String },
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

// The liveness cases (#312) step the TestClock with these.

/**
 * Advance the TestClock (which starts at 0) 1 ms at a time to `millis`, so
 * every heartbeat and sweep due on the way wakes at its own instant and runs
 * (each `TestClock.adjust` yields to the forked fibres) before the next.
 */
const stepTo = (millis: number) =>
  Effect.gen(function* () {
    while ((yield* Clock.currentTimeMillis) < millis) yield* TestClock.adjust("1 millis");
  });

/**
 * Yield to the forked fibres, without moving the clock, until `condition`
 * holds. The bound is a number of scheduler turns, not a time budget.
 */
const settle = (condition: Effect.Effect<boolean>, maxTurns = 100) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (yield* condition) return;
      yield* Effect.yieldNow;
    }
    if (yield* condition) return;
    return yield* Effect.die(new Error(`settle: condition never held in ${maxTurns} turns`));
  });

/**
 * Yield to the forked fibres for `turns` scheduler turns without moving the
 * clock, so work already due by now (a sweep that just woke) has finished
 * before a case asserts that something did not happen.
 */
const drain = (turns = 20) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow;
  });

/** Whether `counter` currently reads `n`. */
const is = (counter: Ref.Ref<number>, n: number) =>
  Effect.map(Ref.get(counter), (count) => count === n);

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
      yield* mirror.mutate("todo/set", { id: "1", title: "from the tab", isDone: false });

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
      yield* first.mutate("todo/set", { id: "1", title: "before", isDone: false });
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
      yield* mirror.mutate("todo/set", { id: "1", title: "still works", isDone: false });
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
  // Both cases run under `it.effect`: the host's sweep and the mirror's
  // heartbeat sleep on the TestClock and its `Clock.currentTimeMillis` stamps
  // last-seen times, so virtual time only moves when a case advances it. The
  // loopback channel is a PubSub, so delivery needs fibre yields, never wall
  // time, and scheduler delay on a loaded machine cannot starve a heartbeat
  // past the timeout (#312).
  const liveness = { mirrorTimeout: "60 millis", sweepInterval: "15 millis" } as const;

  /** The engine with its subscribe and unsubscribe calls counted. */
  const makeCountedEngine = Effect.gen(function* () {
    const { engine } = yield* makeEngine;
    const subs = yield* Ref.make(0);
    const unsubs = yield* Ref.make(0);
    const counted = {
      ...engine,
      subscribe: (subset) =>
        Ref.update(subs, (n) => n + 1).pipe(Effect.andThen(engine.subscribe(subset))),
      unsubscribe: (subset) =>
        Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
    } satisfies typeof engine;
    return { engine: counted, subs, unsubs };
  });

  it.effect("reclaims a subset from a tab that stops heartbeating", () =>
    Effect.gen(function* () {
      const { engine, subs, unsubs } = yield* makeCountedEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine, liveness });

      // A "ghost" tab subscribes directly on the channel and never
      // heartbeats — modelling a crashed tab that can't send Disconnect.
      // The host stamps it last seen at t = 0 when it registers the subset.
      yield* mirrorChannel.post({ _tag: "Subscribe", mirrorId: "ghost", subset: allTodos });
      yield* settle(is(subs, 1));

      // Up to the timeout every sweep finds it fresh: at t = 60 ms it is
      // exactly 60 ms old, which is not yet past the timeout.
      yield* stepTo(60);
      yield* drain();
      expect(yield* Ref.get(unsubs)).toBe(0);

      // The first sweep after that (t = 75 ms) reclaims it, before the clock
      // moves again.
      yield* TestClock.adjust("15 millis");
      yield* settle(is(unsubs, 1));
    })
  );

  it.effect("keeps a live tab's subset across several sweeps", () =>
    Effect.gen(function* () {
      const { engine, subs, unsubs } = yield* makeCountedEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine, liveness });
      // A real mirror heartbeats faster than the timeout.
      const mirror = yield* Mirror.make({
        channel: mirrorChannel,
        mutators,
        heartbeatInterval: "15 millis",
      });
      yield* mirror.subscribe(allTodos);
      yield* settle(is(subs, 1));

      // Across five timeout windows (twenty sweeps) the heartbeat keeps it alive.
      yield* stepTo(300);
      yield* drain();
      expect(yield* Ref.get(unsubs)).toBe(0);
    })
  );
});

describe("EngineHost ↔ Mirror (BroadcastChannel)", () => {
  it.effect("syncs tab to host over a real BroadcastChannel pair", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const name = `legation-test-${crypto.randomUUID()}`;
      const host = yield* BroadcastMirrorChannel.make(name);
      const mirrorChannel = yield* BroadcastMirrorChannel.make(name);
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      yield* mirror.subscribe(allTodos);
      yield* mirror.mutate("todo/set", { id: "1", title: "broadcast", isDone: false });
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
        const name = `legation-test-restart-${crypto.randomUUID()}`;
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
            yield* mirror.mutate("todo/set", { id: "warm", title: "while alive", isDone: false });
            yield* eventually(mirror.query(allTodos), (rows) => rows.length === 1);
          })
        );

        // Sent after the leader is gone: nobody will ever journal or ack it.
        const orphaned = yield* Effect.forkChild(
          mirror.mutate("todo/set", { id: "orphan", title: "never acked", isDone: false })
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
      const name = `legation-test-orphan-scope-${crypto.randomUUID()}`;
      // Nobody is listening on this channel at all — the request can never
      // be answered while the mirror is alive.
      const inFlight = yield* Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* BroadcastMirrorChannel.make(name);
          const mirror = yield* Mirror.make({ channel, mutators });
          return yield* Effect.forkChild(
            mirror.mutate("todo/set", { id: "1", title: "orphaned", isDone: false })
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
      const name = `legation-test-first-ready-${crypto.randomUUID()}`;
      const mirrorChannel = yield* BroadcastMirrorChannel.make(name);
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators });

      // The mutation is issued before the host's own HostReady necessarily
      // finishes propagating to this mirror — a brand-new host's first
      // handshake must never be mistaken for a restart.
      const outcome = yield* Effect.forkChild(
        mirror.mutate("todo/set", { id: "1", title: "first contact", isDone: false })
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
 * A stand-in for `@thomasfosterau/legation-jsonapi`'s `JsonApiQuery.urlReads` (this package
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
/** Whether a pulled summary holds the root window of `allTodos` pulled. */
const rootPulled = (pulled: Coverage.Pulled): boolean =>
  pulled.windows.some(
    (window) => window.pulled && Coverage.windowKey(window.subset) === Coverage.windowKey(allTodos)
  );
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
      yield* engine.mutate("todo/set", { id: "1", title: "by url", isDone: false, authorId: "u1" });

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

  it.effect("nodes alone suffice: the registry defaults to nodes.collections", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      // No `registry`: an include URL must still pin its edge windows, not
      // just the root with a warning.
      yield* EngineHost.run({ channel: host, engine, nodes, urls: stubUrls });
      yield* engine.mutate("todo/set", { id: "1", title: "by url", isDone: false, authorId: "u1" });
      yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/todos?include=author" });
      const registered = yield* eventually(hashes(engine), (current) => current.length === 2);
      expect(new Set(registered)).toEqual(new Set([todosRoot, authorWindow]));
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
            isDone: false,
            authorId: "u1",
          });

          yield* client.subscribe("/todos");
          yield* client.subscribe("/todos?include=author");
          expect(yield* client.subscriptions).toEqual(["/todos", "/todos?include=author"]);
          // The host holds the root once for both pins, plus the author window.
          const registered = yield* eventually(hashes(engine), (current) => current.length === 2);
          expect(new Set(registered)).toEqual(new Set([todosRoot, authorWindow]));
          yield* engine.pull.pipe(Effect.orDie);
          expect(
            (yield* eventually(
              client.coverageOf({ collection: "todos", include: { author: true } }),
              (verdict) => verdict._tag === "Covered"
            ))._tag
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

// ─── The host's registrations as a coverage ledger (#166, ADR-0029 section 3) ─

describe("EngineHost.Host.registrations", () => {
  it.effect(
    "lists what the host holds for its mirrors, with URL identity, and answers coverage like the Client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine } = yield* makeEngine;
          const { host: hostChannel, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
          const host = yield* EngineHost.run({
            channel: hostChannel,
            engine,
            registry: nodes.collections,
            nodes,
            urls: stubUrls,
          });
          const coverageOf = Coverage.coverageOf(
            nodes,
            ClientView.fromEngine(engine).query,
            host.registrations
          );
          const client = yield* Client.connect({
            nodes,
            mutations: mutators,
            channel,
            urls: stubUrls,
          });
          const withAuthor = { collection: "todos", include: { author: true } } as const;

          // Nothing held: nothing covered — the façade would go to the network.
          expect(yield* host.registrations).toEqual([]);
          expect((yield* coverageOf({ collection: "todos" }))._tag).toBe("Uncovered");

          // A connected Client's edged pin arrives as Subscribe + SubscribeRelated:
          // the host records the root and the relational registration (root +
          // edge selects) once their engine registrations exist. The URL
          // identity of that pin lives in the Client's own ledger, not here.
          yield* client.subscribe("/todos?include=author");
          yield* eventually(hashes(engine), (current) => current.includes(todosRoot));
          // Each is listed with its pulled summary; covered once a pull started after it has applied (#426).
          yield* engine.pull.pipe(Effect.orDie);
          const held = yield* eventually(host.registrations, (current) => current.length === 2);
          expect(held.map((entry) => Subset.hash(entry.root))).toEqual([todosRoot, todosRoot]);
          const edged = held.find((entry) => entry.edges.length === 1)!;
          expect(edged.edges).toEqual([{ name: "author" }]);
          expect(edged.url).toBeUndefined();

          // The same verdicts the Client's own ledger gives, from the host's side.
          for (const read of [{ collection: "todos" }, withAuthor]) {
            const verdict = yield* coverageOf(read);
            expect(verdict._tag, JSON.stringify(read)).toBe("Covered");
            // The host tells the mirror which registrations are pulled, so the Client agrees once it hears.
            const local = yield* eventually(
              client.coverageOf(read),
              (current) => current._tag === "Covered"
            );
            expect(verdict._tag).toBe(local._tag);
          }
          expect((yield* coverageOf({ collection: "users" }))._tag).toBe("Uncovered");

          // A page with no Client at all registers by URL: listed the same
          // way, and the host knows its canonical URL.
          yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/api/users" });
          yield* eventually(hashes(engine), (current) => current.length === 2);
          yield* engine.pull.pipe(Effect.orDie);
          const withPage = yield* eventually(host.registrations, (current) => current.length === 3);
          expect(withPage.find((entry) => entry.root.collection === "users")?.url).toBe("/users");
          const users = yield* coverageOf({ collection: "users" });
          expect(users).toMatchObject({ _tag: "Covered", url: "/users" });

          // Release drops the entries; nothing is covered by a registration the
          // engine no longer holds.
          yield* client.unsubscribe("/todos?include=author");
          yield* channel.post({ _tag: "UnsubscribeUrl", mirrorId: "page", url: "/users" });
          yield* eventually(host.registrations, (current) => current.length === 0);
          expect((yield* coverageOf({ collection: "todos" }))._tag).toBe("Uncovered");
        })
      )
  );

  it.effect("records a relational registration only once the engine holds it", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host: hostChannel, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      const host = yield* EngineHost.run({ channel: hostChannel, engine, nodes });
      const coverageOf = Coverage.coverageOf(
        nodes,
        ClientView.fromEngine(engine).query,
        host.registrations
      );
      // An edge the registry does not declare: `Related` would ignore it and
      // register the root alone, so the host refuses the registration
      // outright — nothing held, nothing credited, the root not even subscribed.
      yield* channel.post({
        _tag: "SubscribeRelated",
        mirrorId: "page",
        collection: "todos",
        subset: allTodos,
        edges: [{ name: "nope" }],
      });
      // Messages are handled in order, so a plain subscribe sent after the refused one is
      // registered only once the refusal has been handled: the barrier is observable.
      const barrier = Subset.make({ collection: "users" });
      yield* channel.post({ _tag: "Subscribe", mirrorId: "page", subset: barrier });
      yield* eventually(hashes(engine), (current) => current.includes(Subset.hash(barrier)));
      expect(yield* host.registrations).toMatchObject([{ root: barrier }]);
      expect(yield* hashes(engine)).toEqual([Subset.hash(barrier)]);
      yield* channel.post({ _tag: "Unsubscribe", mirrorId: "page", subset: barrier });
      yield* eventually(hashes(engine), (current) => current.length === 0);
      // A declared edge is held with its root and edge windows registered
      // before it is listed.
      yield* channel.post({
        _tag: "SubscribeRelated",
        mirrorId: "page",
        collection: "todos",
        subset: allTodos,
        edges: [{ name: "author" }],
      });
      const held = yield* eventually(
        host.registrations,
        (current) =>
          current.length === 1 && current[0]!.pulled.windows.every((window) => window.pulled)
      );
      expect(held).toMatchObject([{ root: allTodos, edges: [{ name: "author" }] }]);
      expect(yield* hashes(engine)).toContain(todosRoot);
      expect((yield* coverageOf({ collection: "todos", include: { author: true } }))._tag).toBe(
        "Covered"
      );
      // Releasing it drops the relational read's windows with the entry.
      yield* channel.post({
        _tag: "UnsubscribeRelated",
        mirrorId: "page",
        collection: "todos",
        subset: allTodos,
        edges: [{ name: "author" }],
      });
      yield* eventually(host.registrations, (current) => current.length === 0);
      yield* eventually(hashes(engine), (current) => current.length === 0);
    })
  );

  it.effect("names a URL only while a party holds the registration by that URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const { host: hostChannel, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
        const host = yield* EngineHost.run({ channel: hostChannel, engine, nodes, urls: stubUrls });
        const coverageOf = Coverage.coverageOf(
          nodes,
          ClientView.fromEngine(engine).query,
          host.registrations
        );
        const mirror = yield* Mirror.make({ channel, mutators });
        // A tab's plain pin and a page's URL pin share one root window: the
        // entry carries the page's URL while the page holds it...
        yield* mirror.subscribe(allTodos);
        yield* channel.post({ _tag: "SubscribeUrl", mirrorId: "page", url: "/todos" });
        yield* eventually(hashes(engine), (current) => current.length === 1);
        yield* engine.pull.pipe(Effect.orDie);
        const both = yield* eventually(
          host.registrations,
          (current) => current.length === 1 && current[0]!.url === "/todos"
        );
        expect(both).toMatchObject([{ root: allTodos, edges: [], url: "/todos" }]);
        expect(yield* coverageOf({ collection: "todos" })).toMatchObject({ url: "/todos" });
        // ...and no longer once the page releases: the tab still holds the
        // window, so it stays covered, but no URL names it.
        yield* channel.post({ _tag: "UnsubscribeUrl", mirrorId: "page", url: "/todos" });
        const tabOnly = yield* eventually(
          host.registrations,
          (current) => current.length === 1 && current[0]!.url === undefined
        );
        expect(tabOnly).toMatchObject([{ root: allTodos, edges: [] }]);
        const verdict = yield* coverageOf({ collection: "todos" });
        expect(verdict._tag).toBe("Covered");
        expect(verdict._tag === "Covered" && verdict.url).toBeUndefined();
      })
    )
  );

  it.effect("tells a mirror when the host's replica holds its registration (#426)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const { host: hostChannel, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: hostChannel, engine });
        const mirror = yield* Mirror.make({ channel, mutators });
        expect(rootPulled(yield* mirror.pulled(todosRoot))).toBe(false);
        yield* mirror.subscribe(allTodos);
        // The host pulls after registering and sends `PulledRegistrations` once that pull has applied.
        yield* eventually(mirror.pulled(todosRoot), (pulled) => rootPulled(pulled));
        // Released, the mirror no longer holds it pulled.
        yield* mirror.unsubscribe(allTodos);
        yield* eventually(mirror.pulled(todosRoot), (pulled) => !rootPulled(pulled));
      })
    )
  );

  it.effect("does not list named-query or mutation-state registrations", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host: hostChannel, mirror: channel } = yield* MirrorChannel.makeLoopbackPair;
      const host = yield* EngineHost.run({ channel: hostChannel, engine });
      const mirror = yield* Mirror.make({ channel, mutators });
      yield* channel.post({ _tag: "SubscribeMutationStates", mirrorId: "page" });
      yield* mirror.subscribe(allTodos);
      yield* eventually(hashes(engine), (current) => current.length === 1);
      yield* engine.pull.pipe(Effect.orDie);
      const held = yield* eventually(host.registrations, (current) => current.length === 1);
      expect(held).toMatchObject([{ root: allTodos, edges: [] }]);
    })
  );
});
