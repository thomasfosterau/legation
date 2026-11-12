/**
 * The reference topology over Alchemy's services stubbed at the service seam
 * (`harness.ts`): the provider's own state and storage adapters over in-memory
 * workerd fakes, namespaces as in-process RPC dispatch — everything else is
 * the real code. The headline test wires REAL client engines to two room
 * instances (shared MemoryBackend, topic shards between them) and shows a
 * write on room B poking room A's hibernation-style socket AND its
 * fine-registered window converging, while a write to a different parent
 * leaves room A silent.
 *
 * The headline test waits for specific events (a lease written at a shard, a
 * publish answered, a window updated), never for a fixed time. Its room's
 * heartbeat runs on a TestClock, so a beat happens only when the test advances
 * time, and its leases outlive any real run (see the headline test), so a
 * loaded machine cannot age a lease out between its beat and the write it must
 * route (#282).
 */
import { describe, expect, it } from "@effect/vitest";
import type * as cf from "@cloudflare/workers-types";
import { PreparedStatement, type QueryDatabaseClient } from "@alchemy.run/cloudflare/D1";
import * as Workers from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { awaitPromise } from "./await-promise.js";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  Authorization,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutation,
  Node,
  Query,
  Transport,
} from "@thomasfosterau/legation";
import { ClientEngine, ClientView, Cvr } from "@thomasfosterau/legation/internal";
import * as D1Executor from "../D1Executor.js";
import * as DurableCvrStore from "../DurableCvrStore.js";
import * as FanoutShard from "../FanoutShard.js";
import * as Room from "../Room.js";
import { routes } from "../RoomProtocol.js";
import { routeSync } from "../Worker.js";
import { defined } from "./defined.js";
import {
  construct,
  fakeBinding,
  fetchOf,
  type Instance,
  makeNamespace,
  makeRawStorage,
  makeSocket,
  makeStorage,
  runtimeContext,
} from "./harness.js";
import { TestFailure } from "./test-failure.js";

/** Run an effect that needs the runtime context, as inside a Durable Object event. */
const inRuntime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(RuntimeContext, runtimeContext)));

// ─── Units ───────────────────────────────────────────────────────────────────

describe("DurableCvrStore", () => {
  it("round-trips CVRs through DO storage", async () => {
    const store = await inRuntime(DurableCvrStore.make(makeStorage()));
    const cvr: Cvr.Cvr = { rows: new Map([["products", new Map([["p-1", 3]])]]) };
    await inRuntime(store.set("cookie-1", cvr));
    const loaded = await inRuntime(store.get("cookie-1"));
    expect(loaded?.rows.get("products")?.get("p-1")).toBe(3);
    await inRuntime(store.remove("cookie-1"));
    expect(await inRuntime(store.get("cookie-1"))).toBeUndefined();
  });

  it("surfaces a failed storage call as a StoreError", async () => {
    const raw = makeRawStorage();
    raw.get = () => Promise.reject(new TestFailure({ message: "storage unavailable" }));
    const store = await inRuntime(DurableCvrStore.make(Workers.fromDurableObjectStorage(raw)));
    const exit = await Effect.runPromiseExit(store.get("cookie-1"));
    expect(Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag))).toEqual(
      Option.some("StoreError")
    );
  });
});

describe("FanoutShard", () => {
  it("leases: keeps live rooms and drops expired ones", async () => {
    const storage = makeStorage();
    await inRuntime(FanoutShard.leases.register(storage, "room-a", 1000, 0));
    await inRuntime(FanoutShard.leases.register(storage, "room-b", 1000, 500));
    expect(await inRuntime(FanoutShard.leases.live(storage, 900))).toEqual(["room-a", "room-b"]);
    // room-a expired at 1000; room-b at 1500.
    expect(await inRuntime(FanoutShard.leases.live(storage, 1200))).toEqual(["room-b"]);
    // The expired entry was deleted as a side effect.
    expect(await inRuntime(FanoutShard.leases.live(storage, 900))).toEqual(["room-b"]);
  });

  it.effect("answers a publish with the rooms registered on its topic", () =>
    Effect.gen(function* () {
      const shard = yield* construct(
        "reviews",
        FanoutShard.make,
        fakeBinding<Workers.DurableObject>({})
      );
      yield* shard.run(shard.object.register("room-a", 60_000));
      yield* shard.run(shard.object.register("room-b", 60_000));
      expect(yield* shard.run(shard.object.publish())).toEqual(["room-a", "room-b"]);
    })
  );
});

/** A raw D1 binding over canned rows, recording each statement it runs. */
const makeRawD1 = (rows: ReadonlyArray<Record<string, unknown>>, fail = false) => {
  const statements: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = [];
  const raw = fakeBinding<cf.D1Database>({
    prepare: (sql: string) => {
      const statement = (params: ReadonlyArray<unknown>) => ({
        bind: (...values: ReadonlyArray<unknown>) => statement(values),
        all: async () => {
          statements.push({ sql, params });
          if (fail) throw new TestFailure({ message: "D1_ERROR: no such table" });
          return { results: rows, success: true, meta: {} };
        },
        run: async () => {
          statements.push({ sql, params });
          if (fail) throw new TestFailure({ message: "D1_ERROR: no such table" });
          return { results: [], success: true, meta: {} };
        },
      });
      return statement([]);
    },
  });
  // The client `Cloudflare.D1.QueryDatabase(database)` binds, over the raw binding.
  const rawEffect = Effect.succeed(raw);
  const client = fakeBinding<QueryDatabaseClient>({
    raw: rawEffect,
    prepare: (sql: string) => new PreparedStatement(sql, [], rawEffect),
  });
  return { client, statements };
};

describe("D1Executor", () => {
  it("declares no transactions, so SqlBackend keeps the handler-then-bump order (#342, #359)", async () => {
    // A claim committed on its own would be skipped by a retry after a crash.
    const executor = await inRuntime(D1Executor.make(makeRawD1([]).client));
    expect(executor.transactional).toBe(false);
  });

  it("runs queries and statements through the client's prepared statements", async () => {
    const d1 = makeRawD1([{ id: "p-1", name: "Mug" }]);
    const executor = await inRuntime(D1Executor.make(d1.client));
    const rows = await Effect.runPromise(
      executor.query({ text: "SELECT * FROM products WHERE id = ?", params: ["p-1"] })
    );
    expect(rows).toEqual([{ id: "p-1", name: "Mug" }]);
    await Effect.runPromise(
      executor.run({ text: "DELETE FROM products WHERE id = ?", params: ["p-2"] })
    );
    expect(d1.statements).toEqual([
      { sql: "SELECT * FROM products WHERE id = ?", params: ["p-1"] },
      { sql: "DELETE FROM products WHERE id = ?", params: ["p-2"] },
    ]);
  });

  it("surfaces a failed statement as a BackendError", async () => {
    const executor = await inRuntime(D1Executor.make(makeRawD1([], true).client));
    const exit = await Effect.runPromiseExit(executor.query({ text: "SELECT 1", params: [] }));
    expect(Exit.findErrorOption(exit).pipe(Option.map((error) => error._tag))).toEqual(
      Option.some("BackendError")
    );
  });
});

describe("routeSync", () => {
  // The stub answers which room was addressed and the path it was given.
  const stubRooms = fakeBinding<Workers.DurableObject<Room.RoomObject>>({
    getByName: (name: string) => ({
      fetch: (request: HttpServerRequest.HttpServerRequest) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ room: name, path: request.url })),
    }),
  });
  const roomIdOf = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed(new URL(request.url, "https://app").searchParams.get("user") ?? undefined);
  const route = (path: string, basePath?: string) =>
    Effect.runPromise(
      routeSync({ rooms: stubRooms, roomIdOf, basePath }).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`https://app.example.com${path}`))
        ),
        Effect.map(Option.map((response) => HttpServerResponse.toWeb(response))),
        Effect.orDie
      )
    );

  it("ignores paths outside the base so the app handler runs", async () => {
    expect(Option.isNone(await route("/api/products"))).toBe(true);
    expect(Option.isNone(await route("/"))).toBe(true);
  });

  it("404s an unknown route under the base", async () => {
    expect(defined(Option.getOrUndefined(await route("/sync/nonsense?user=u-1"))).status).toBe(404);
    expect(
      defined(Option.getOrUndefined(await route(`/sync/deeper${routes.pull}?user=u-1`))).status
    ).toBe(404);
  });

  it("401s an anonymous caller (no resolved room)", async () => {
    expect(defined(Option.getOrUndefined(await route(`/sync${routes.pull}`))).status).toBe(401);
  });

  it("forwards a sync route to the caller's room, unchanged", async () => {
    const response = defined(Option.getOrUndefined(await route(`/sync${routes.pull}?user=u-1`)));
    expect(await response.json()).toEqual({ room: "u-1", path: `/sync${routes.pull}?user=u-1` });
  });

  it("honours a custom base path", async () => {
    const routed = await route(`/legation${routes.push}?user=u-2`, "/legation");
    const response = defined(Option.getOrUndefined(routed));
    expect(await response.json()).toEqual({
      room: "u-2",
      path: `/legation${routes.push}?user=u-2`,
    });
  });
});

// ─── The topology, end to end ────────────────────────────────────────────────

const Product = Node.make("products", {
  attributes: { name: Schema.String },
  edges: { reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }) },
});
const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const nodes = Node.registry([Product, Review]);

const reviewSet = Mutation.make("review/set", Schema.Unknown);
const mutations = Mutation.registry([
  {
    mutator: reviewSet,
    local: (args, writer) => writer.put("reviews", (args as { id: string }).id, args),
  },
]);

/** A call a shard has answered: which shard (topic), which method, which room. */
interface ShardCall {
  readonly shard: string;
  readonly method: "register" | "publish";
  readonly roomId?: string | undefined;
}

/**
 * Every shard call, recorded once the shard has answered it, and a way to
 * wait for one. A publish's pokes follow its answer, so the tests wait for the
 * poke itself where they need it (`pokes` below).
 */
const makeCalls = <Call>() => {
  const calls: Array<Call> = [];
  const waiters: Array<{ readonly match: (call: Call) => boolean; readonly done: () => void }> = [];
  return {
    record: (call: Call) => {
      calls.push(call);
      Arr.forEach(
        waiters.filter((w) => w.match(call)),
        (waiter) => {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done();
        }
      );
    },
    /** How many calls have completed so far: a mark to pass to `next`. */
    count: () => calls.length,
    /**
     * Resolve once a matching call has completed, counting only calls after
     * the `since` mark (at once if one already has).
     */
    next: (match: (call: Call) => boolean, since = 0): Promise<void> =>
      calls.slice(since).some(match)
        ? Promise.resolve()
        : new Promise<void>((done) => waiters.push({ match, done })),
  };
};

/** A ClientTransport calling a room instance's fetch directly. */
const roomTransport = (send: (request: Request) => Promise<Response>) => {
  const post = (route: string) => (body: unknown) =>
    awaitPromise(async () => {
      const response = await send(
        new Request(`https://room${route}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        })
      );
      return (await response.json()) as never;
    }).pipe(Effect.orDie);
  return {
    push: post(routes.push),
    pull: post(routes.pull),
    read: post(routes.read),
    pokes: Stream.empty,
    status: Effect.succeed("connected" as const),
    statusChanges: Stream.succeed("connected" as const),
  } as Transport.ClientTransport;
};

const publishPolicy = Effect.succeed(
  Authorization.policy({
    products: Authorization.allowAll,
    reviews: Authorization.allowAll,
  })
);

const backendOf = () =>
  MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(reviewSet, (args, writer) =>
        writer.put("reviews", (args as { id: string }).id, args)
      ),
    ])
  );

/**
 * A room namespace whose instances are built on first address from `config`.
 * The rooms poke each other through it, as through their own namespace.
 */
const makeRooms = (config: Room.RoomConfig) => {
  const instances = new Map<string, Promise<Instance<Room.RoomObject>>>();
  const pokes = makeCalls<{ readonly room: string; readonly topics: ReadonlyArray<string> }>();
  const namespace: Workers.DurableObject<Room.RoomObject> = makeNamespace<Room.RoomObject>((name) =>
    awaitPromise(() => room(name)).pipe(Effect.orDie)
  );
  const room = (name: string): Promise<Instance<Room.RoomObject>> => {
    let instance = instances.get(name);
    if (instance === undefined) {
      instance = Effect.runPromise(
        construct(name, Room.make(config), namespace).pipe(
          Effect.map((built): Instance<Room.RoomObject> => ({
            ...built,
            object: {
              ...built.object,
              // Record each poke once the room has delivered it.
              poke: (topics) =>
                Effect.tap(built.object.poke(topics), () =>
                  Effect.sync(() => pokes.record({ room: name, topics }))
                ),
            },
          }))
        )
      );
      instances.set(name, instance);
    }
    return instance;
  };
  return { room, pokes };
};

describe("rooms + shards, end to end", () => {
  it.live(
    "a cross-room write pokes the fine-registered room's sockets and window",
    () =>
      Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          awaitPromise(async () => {
            // The room's heartbeat sleeps on this clock, so it beats only when the test
            // advances time. Shards stamp leases with the real wall clock; a 10 minute
            // beat gives a 30 minute TTL, which no run of this test can outlive. (A
            // 150 ms TTL on real time expired under event-loop starvation; expiry has
            // its own unit test above.)
            const clock = await Effect.runPromise(TestClock.make().pipe(Scope.provide(scope)));
            const backend = await Effect.runPromise(backendOf().pipe(Scope.provide(scope)));

            const shardCalls = makeCalls<ShardCall>();
            const shardInstances = new Map<string, Promise<Instance<FanoutShard.ShardObject>>>();
            const noSelf = fakeBinding<Workers.DurableObject>({});
            const shardNamed = (name: string) => {
              let shard = shardInstances.get(name);
              if (shard === undefined) {
                shard = Effect.runPromise(
                  construct(name, FanoutShard.make, noSelf).pipe(
                    Effect.map((built): Instance<FanoutShard.ShardObject> => ({
                      ...built,
                      object: {
                        register: (roomId, ttlMillis) =>
                          Effect.tap(built.object.register(roomId, ttlMillis), () =>
                            Effect.sync(() =>
                              shardCalls.record({ shard: name, method: "register", roomId })
                            )
                          ),
                        publish: () =>
                          Effect.tap(built.object.publish(), () =>
                            Effect.sync(() => shardCalls.record({ shard: name, method: "publish" }))
                          ),
                      },
                    }))
                  )
                );
                shardInstances.set(name, shard);
              }
              return shard;
            };
            const shards = makeNamespace<FanoutShard.ShardObject>((name) =>
              awaitPromise(() => shardNamed(name)).pipe(Effect.orDie)
            );
            const { room, pokes } = makeRooms({
              nodes,
              backend: Effect.succeed(backend),
              policy: publishPolicy,
              shards: Effect.succeed(shards),
              heartbeat: "10 minutes",
              clock,
            });

            const roomA = await room("room-a");
            const roomB = await room("room-b");

            // Room A gets a hibernation-style socket (poke frames land here).
            // The `/socket` upgrade itself needs Workers globals (WebSocketPair,
            // 101 responses) that Node lacks, so the fake is accepted directly.
            const socketA = makeSocket();
            roomA.sockets.push(socketA);

            // A real client engine on room A observes p-1's reviews (fine window).
            const readerScope = Scope.makeUnsafe();
            const reader = await Effect.runPromise(
              Effect.gen(function* () {
                const store = yield* ClientStore.makeMemory;
                return yield* ClientEngine.make({
                  clientId: "client-a",
                  clientGroupId: "group-a",
                  mutators: mutations,
                  syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 millis" },
                }).pipe(
                  Effect.provideService(ClientStore.ClientStore, store),
                  Effect.provideService(Transport.ClientTransport, roomTransport(fetchOf(roomA)))
                );
              }).pipe(Scope.provide(readerScope))
            );
            const readerClient = Client.fromView(nodes, ClientView.fromEngine(reader));
            const latest: Array<ReadonlyArray<unknown>> = [[]];
            // Resolves on the observer's first emission (its window is subscribed by
            // then), and on the first emission holding one row.
            let subscribed!: () => void;
            const isSubscribed = new Promise<void>((resolve) => (subscribed = resolve));
            let converged!: () => void;
            const hasConverged = new Promise<void>((resolve) => (converged = resolve));
            const observing = Effect.runPromise(
              Stream.runForEach(
                readerClient.observe({ collection: "reviews", where: { productId: "p-1" } }),
                (rows) =>
                  Effect.sync(() => {
                    latest[0] = rows;
                    subscribed();
                    if (rows.length === 1) converged();
                  })
              ).pipe(Scope.provide(readerScope), Effect.ignore)
            );
            void observing;
            await isSubscribed;
            await Effect.runPromise(reader.pull.pipe(Effect.orDie));
            // One beat (on the room's clock) leases the fine topic at its shard.
            await Effect.runPromise(clock.adjust("10 minutes"));
            await shardCalls.next(
              (call) =>
                call.shard === "reviews/productId=p-1" &&
                call.method === "register" &&
                call.roomId === "room-a"
            );

            // Room B's client writes a p-1 review and pushes.
            const writerScope = Scope.makeUnsafe();
            const writer = await Effect.runPromise(
              Effect.gen(function* () {
                const store = yield* ClientStore.makeMemory;
                return yield* ClientEngine.make({
                  clientId: "client-b",
                  clientGroupId: "group-b",
                  mutators: mutations,
                }).pipe(
                  Effect.provideService(ClientStore.ClientStore, store),
                  Effect.provideService(Transport.ClientTransport, roomTransport(fetchOf(roomB)))
                );
              }).pipe(Scope.provide(writerScope))
            );
            await Effect.runPromise(
              writer.mutate("review/set", {
                id: "r-1",
                body: "cross-room",
                createdAt: "2026-01-01",
                productId: "p-1",
              })
            );
            await Effect.runPromise(writer.push.pipe(Effect.orDie));

            // Room B poked room A over RPC with the fine topic its lease matched: room A's
            // socket has a contentless frame…
            await pokes.next(
              (poke) => poke.room === "room-a" && poke.topics.includes("reviews/productId=p-1")
            );
            expect(socketA.sent.length).toBeGreaterThan(0);
            expect(JSON.parse(defined(socketA.sent[0]))).toEqual({ type: "poke" });
            // …and (a client honouring the poke pulls) the window converges.
            await Effect.runPromise(reader.pull.pipe(Effect.orDie));
            await hasConverged;
            expect(latest[0]).toHaveLength(1);

            // A write to a DIFFERENT parent leaves room A's socket silent.
            const sends = socketA.sent.length;
            const before = shardCalls.count();
            await Effect.runPromise(
              writer.mutate("review/set", {
                id: "r-2",
                body: "other parent",
                createdAt: "2026-01-02",
                productId: "p-9",
              })
            );
            await Effect.runPromise(writer.push.pipe(Effect.orDie));
            // Both of the write's topics are published: the coarse one and the p-9 one.
            // The push returns after its publish, pokes included, so nothing is in flight.
            await shardCalls.next(
              (call) => call.shard === "reviews" && call.method === "publish",
              before
            );
            await shardCalls.next(
              (call) => call.shard === "reviews/productId=p-9" && call.method === "publish",
              before
            );
            expect(socketA.sent.length).toBe(sends);

            await Effect.runPromise(Scope.close(writerScope, Exit.void));
            await Effect.runPromise(Scope.close(readerScope, Exit.void));
          }),
        (scope) => Scope.close(scope, Exit.void)
      ),
    20_000
  );
});

// The room's boot, heartbeat and request handling run on the TestClock (the
// `clock` seam), so the bound is crossed by advancing virtual time. The writer
// and reader engines stay on the real clock. The hung shards record each
// call, and `arrived` resolves once the room has made that many.
const makeHungShards = () => {
  const received: Array<{ readonly shard: string; readonly method: string }> = [];
  const waiters: Array<{ readonly count: number; readonly done: () => void }> = [];
  const hang = (shard: string, method: string) =>
    Effect.suspend(() => {
      received.push({ shard, method });
      Arr.forEach(
        waiters.filter((w) => received.length >= w.count),
        (waiter) => waiter.done()
      );
      return Effect.never;
    });
  const namespace = fakeBinding<Workers.DurableObject<FanoutShard.ShardObject>>({
    getByName: (shard: string) => ({
      register: () => hang(shard, "register"),
      publish: () => hang(shard, "publish"),
    }),
  });
  return {
    namespace,
    received,
    arrived: (count: number): Promise<void> =>
      received.length >= count
        ? Promise.resolve()
        : new Promise<void>((done) => waiters.push({ count, done })),
  };
};

/** A client engine on the real clock, talking to `room` over the room transport. */
const makeClient = (
  room: Instance<Room.RoomObject>,
  scope: Scope.Scope,
  clientId: string,
  clientGroupId: string,
  syncLoop?: ClientEngine.SyncLoopOptions
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      const options = { clientId, clientGroupId, mutators: mutations };
      return yield* ClientEngine.make(
        syncLoop === undefined ? options : { ...options, syncLoop }
      ).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, roomTransport(fetchOf(room)))
      );
    }).pipe(Scope.provide(scope))
  );

/** A room over hung shards, on `clock`, with `options` on top of the defaults. */
const hungRoom = (
  name: string,
  clock: TestClock.TestClock,
  shards: Workers.DurableObject<FanoutShard.ShardObject>,
  options: Partial<Room.RoomConfig>
) =>
  Effect.gen(function* () {
    const backend = yield* backendOf();
    return yield* awaitPromise(() =>
      makeRooms({
        nodes,
        backend: Effect.succeed(backend),
        policy: publishPolicy,
        shards: Effect.succeed(shards),
        clock,
        ...options,
      }).room(name)
    );
  });

/** Mutate one review through `writer`. */
const writeReview = (writer: ClientEngine.ClientEngine, id: string, productId: string) =>
  awaitPromise(() =>
    Effect.runPromise(
      writer.mutate("review/set", { id, body: "hung shard", createdAt: "2026-01-01", productId })
    )
  );

describe("Room publishTimeout", () => {
  it.effect(
    "a hung shard call is dropped at publishTimeout, not at the 5 second default",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const scope = yield* Scope.Scope;
        const hung = makeHungShards();
        const room = yield* hungRoom("room-hung", clock, hung.namespace, {
          publishTimeout: "200 millis",
        });
        const writer = yield* awaitPromise(() =>
          makeClient(room, scope, "client-hung", "group-hung")
        );
        yield* writeReview(writer, "r-1", "p-1");

        // The push's change hint publishes to the hung shards, so it cannot finish
        // until the bound drops them.
        let pushed = false;
        const push = Effect.runPromise(writer.push.pipe(Effect.orDie)).then(() => {
          pushed = true;
        });
        yield* awaitPromise(() => hung.arrived(1));
        yield* clock.adjust("199 millis");
        expect(pushed).toBe(false);
        yield* clock.adjust("1 millis");
        yield* awaitPromise(() => push);
        expect(hung.received.map((call) => call.method)).toEqual(["publish", "publish"]);
      }).pipe(Effect.scoped),
    20_000
  );

  it.effect(
    "a publish fanning out past the shard concurrency is bounded as a whole, not per wave",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const scope = yield* Scope.Scope;
        const hung = makeHungShards();
        const room = yield* hungRoom("room-wide", clock, hung.namespace, {
          publishTimeout: "200 millis",
        });
        const writer = yield* awaitPromise(() =>
          makeClient(room, scope, "client-wide", "group-wide")
        );
        // Nine products in one push: the coarse topic plus nine fine ones, ten shard
        // calls. The broker runs eight at a time, so a second wave waits on the first.
        for (let product = 1; product <= 9; product++) {
          yield* writeReview(writer, `r-${product}`, `p-${product}`);
        }

        let pushed = false;
        const push = Effect.runPromise(writer.push.pipe(Effect.orDie)).then(() => {
          pushed = true;
        });
        yield* awaitPromise(() => hung.arrived(8));
        yield* clock.adjust("199 millis");
        expect(pushed).toBe(false);
        // One bound covers the whole publish: the second wave is dropped with the first.
        yield* clock.adjust("1 millis");
        yield* awaitPromise(() => push);
      }).pipe(Effect.scoped),
    20_000
  );

  it.effect(
    "a hung lease registration at a heartbeat is dropped at publishTimeout, and the heartbeat goes on",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const scope = yield* Scope.Scope;
        const hung = makeHungShards();
        const room = yield* hungRoom("room-lease", clock, hung.namespace, {
          heartbeat: "1 second",
          publishTimeout: "200 millis",
        });
        const reader = yield* awaitPromise(() =>
          makeClient(room, scope, "client-lease", "group-lease", {
            pullInterval: "10 minutes",
            pushDebounce: "10 millis",
          })
        );
        // A client observing p-1's reviews gives the room a window to lease.
        const readerClient = Client.fromView(nodes, ClientView.fromEngine(reader));
        let subscribed!: () => void;
        const isSubscribed = new Promise<void>((resolve) => (subscribed = resolve));
        const observing = Effect.runPromise(
          Stream.runForEach(
            readerClient.observe({ collection: "reviews", where: { productId: "p-1" } }),
            () => Effect.sync(() => subscribed())
          ).pipe(Scope.provide(scope), Effect.ignore)
        );
        void observing;
        yield* awaitPromise(() => isSubscribed);
        yield* awaitPromise(() => Effect.runPromise(reader.pull.pipe(Effect.orDie)));

        // t = 1 s: the first heartbeat registers the window and hangs.
        yield* clock.adjust("1 second");
        yield* awaitPromise(() => hung.arrived(1));
        expect(hung.received[0]).toEqual({ shard: "reviews/productId=p-1", method: "register" });
        // The bound drops it at t = 1.2 s; the next heartbeat is one interval later, at
        // t = 2.2 s. With the 5 second default that second registration would not start
        // until t = 6 s.
        yield* clock.adjust("199 millis");
        yield* clock.adjust("1 millis");
        yield* clock.adjust("1 second");
        yield* awaitPromise(() => hung.arrived(2));
        expect(hung.received.map((call) => call.method)).toEqual(["register", "register"]);
      }).pipe(Effect.scoped),
    20_000
  );

  it.effect(
    "a publishTimeout above the broker's 5 second default bounds a hung shard call at publishTimeout",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const scope = yield* Scope.Scope;
        const hung = makeHungShards();
        const room = yield* hungRoom("room-long", clock, hung.namespace, {
          publishTimeout: "8 seconds",
        });
        const writer = yield* awaitPromise(() =>
          makeClient(room, scope, "client-long", "group-long")
        );
        yield* writeReview(writer, "r-1", "p-1");

        let pushed = false;
        const push = Effect.runPromise(writer.push.pipe(Effect.orDie)).then(() => {
          pushed = true;
        });
        yield* awaitPromise(() => hung.arrived(2));
        // Past the broker's 5 second default the hung calls are still pending: were the broker
        // bounded at its default, the push would have finished here.
        yield* clock.adjust("5 seconds");
        expect(pushed).toBe(false);
        yield* clock.adjust("2999 millis");
        expect(pushed).toBe(false);
        yield* clock.adjust("1 millis");
        yield* awaitPromise(() => push);
        expect(hung.received.map((call) => call.method)).toEqual(["publish", "publish"]);
      }).pipe(Effect.scoped),
    20_000
  );
});

/** A protocol body as the room's routes read it. */
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Room HTTP routes", () => {
  it.effect("answers a route by its last path segment, and 404s anything else", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.testClockWith(Effect.succeed);
      // With the optional services too, so each is provided to the server.
      const room = yield* hungRoom("room-routes", clock, makeHungShards().namespace, {
        identity: Effect.succeed({ resolve: () => Effect.succeed("user-1") }),
        queries: Effect.succeed(Query.resolver([])),
      });
      const send = fetchOf(room);
      const post = (path: string) =>
        awaitPromise(() =>
          send(
            new Request(`https://room${path}`, {
              method: "POST",
              body: JSON.stringify({ not: "a request" }),
              headers: { "content-type": "application/json" },
            })
          )
        );
      // An undecodable body reaches the route and is a 400, base path or not.
      expect((yield* post(routes.pull)).status).toBe(400);
      expect((yield* post(`/sync${routes.pull}`)).status).toBe(400);
      expect((yield* post(routes.push)).status).toBe(400);
      expect((yield* post(`/sync${routes.read}`)).status).toBe(400);
      expect((yield* post("/nonsense")).status).toBe(404);
    }).pipe(Effect.scoped)
  );

  it.effect("presents each request's headers to the IdentityResolver as its credentials", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.testClockWith(Effect.succeed);
      const seen: Array<Option.Option<string>> = [];
      const room = yield* hungRoom("room-credentials", clock, makeHungShards().namespace, {
        identity: Effect.succeed({
          resolve: ({ credentials }) =>
            Effect.sync(() => {
              seen.push(credentials.header("Cookie"));
            }),
        }),
      });
      const send = fetchOf(room);
      const json = { "content-type": "application/json" };
      const post = (path: string, body: Schema.Json, cookie: Option.Option<string>) =>
        Effect.tryPromise(() =>
          send(
            new Request(`https://room/sync${path}`, {
              method: "POST",
              body: encodeBody(body),
              headers: Option.match(cookie, {
                onNone: () => json,
                onSome: (value) => ({ ...json, cookie: value }),
              }),
            })
          )
        ).pipe(Effect.orDie);
      const session = Option.some("sid=room-session");
      expect(
        (yield* post(routes.push, { clientGroupId: "group-c", mutations: [] }, session)).status
      ).toBe(200);
      expect(
        (yield* post(routes.pull, { clientGroupId: "group-c", subscriptions: [] }, session)).status
      ).toBe(200);
      expect(
        (yield* post(routes.read, { clientGroupId: "group-c", subsets: [] }, Option.none())).status
      ).toBe(200);
      expect(seen).toEqual([session, session, Option.none()]);
    }).pipe(Effect.scoped)
  );
});
