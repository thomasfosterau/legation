/**
 * The reference topology over runtime stubs: DO storage as a Map, DO
 * namespaces as in-memory dispatch — everything else is the real code.
 * The headline test wires REAL client engines to two room instances
 * (shared MemoryBackend, topic shards between them) and shows a write on
 * room B poking room A's hibernation-style socket AND its fine-registered
 * window converging, while a write to a different parent leaves room A
 * silent.
 *
 * The headline test waits for specific events (a lease written at a shard, a
 * publish answered, a window updated), never for a fixed time, and pins
 * `Date` (which the shards read for lease expiry) so a loaded machine cannot
 * age a lease out between its heartbeat and the write it must route (#282).
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import type {
  D1Database,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";
import {
  Authorization,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutation,
  Node,
  Transport,
} from "@thomasfosterau/legation-effect";
import { ClientEngine, ClientView, Cvr } from "@thomasfosterau/legation-effect/internal";
import * as D1Executor from "../D1Executor.js";
import * as DurableCvrStore from "../DurableCvrStore.js";
import { leases, makeShardClass } from "../FanoutShard.js";
import { makeRoomClass } from "../Room.js";
import { routes } from "../RoomProtocol.js";
import { routeSync } from "../Worker.js";

// ─── Runtime stubs ───────────────────────────────────────────────────────────

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const makeStorage = (): DurableObjectStorage => {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => void data.set(key, value),
    delete: async (key: string) => data.delete(key),
    list: async (options?: { prefix?: string }) => {
      const out = new Map<string, unknown>();
      for (const [key, value] of data) {
        if (options?.prefix === undefined || key.startsWith(options.prefix)) out.set(key, value);
      }
      return out;
    },
  } as unknown as DurableObjectStorage;
};

interface FakeSocket {
  readonly sent: Array<string>;
  send: (data: string) => void;
}

const makeState = (name: string) => {
  const sockets: Array<FakeSocket> = [];
  const state = {
    id: { name, toString: () => name },
    storage: makeStorage(),
    acceptWebSocket: (socket: unknown) => sockets.push(socket as FakeSocket),
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState;
  return { state, sockets };
};

/** An in-memory DO namespace: `idFromName` is identity, `fetch` dispatches. */
const makeNamespace = (
  dispatch: (name: string, request: Request) => Promise<Response>
): DurableObjectNamespace =>
  ({
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: (url: string, init?: RequestInit) => dispatch(id.name, new Request(url, init)),
    }),
  }) as unknown as DurableObjectNamespace;

// ─── Units ───────────────────────────────────────────────────────────────────

describe("DurableCvrStore", () => {
  it("round-trips CVRs through DO storage", async () => {
    const store = DurableCvrStore.make(makeStorage());
    const cvr: Cvr.Cvr = { rows: new Map([["products", new Map([["p-1", 3]])]]) };
    await Effect.runPromise(store.set("cookie-1", cvr));
    const loaded = await Effect.runPromise(store.get("cookie-1"));
    expect(loaded?.rows.get("products")?.get("p-1")).toBe(3);
    await Effect.runPromise(store.remove("cookie-1"));
    expect(await Effect.runPromise(store.get("cookie-1"))).toBeUndefined();
  });
});

describe("FanoutShard leases", () => {
  it("keeps live rooms and drops expired ones", async () => {
    const storage = makeStorage();
    await leases.register(storage, "room-a", 1000, 0);
    await leases.register(storage, "room-b", 1000, 500);
    expect(await leases.live(storage, 900)).toEqual(["room-a", "room-b"]);
    // room-a expired at 1000; room-b at 1500.
    expect(await leases.live(storage, 1200)).toEqual(["room-b"]);
    // The expired entry was deleted as a side effect.
    expect(await leases.live(storage, 900)).toEqual(["room-b"]);
  });
});

describe("routeSync", () => {
  const config = {
    rooms: () =>
      makeNamespace(async (name, request) =>
        json({ room: name, path: new URL(request.url).pathname })
      ),
    roomIdOf: (request: Request) => new URL(request.url).searchParams.get("user") ?? undefined,
  };
  const get = (path: string) => new Request(`https://app.example.com${path}`);

  it("ignores paths outside the base so the app handler runs", async () => {
    expect(await routeSync(config)(get("/api/products"), {})).toBeUndefined();
    expect(await routeSync(config)(get("/"), {})).toBeUndefined();
  });

  it("404s an unknown route under the base", async () => {
    const response = await routeSync(config)(get("/sync/nonsense?user=u-1"), {});
    expect(response?.status).toBe(404);
  });

  it("401s an anonymous caller (no resolved room)", async () => {
    const response = await routeSync(config)(get(`/sync${routes.pull}`), {});
    expect(response?.status).toBe(401);
  });

  it("forwards a sync route to the caller's room, path rewritten", async () => {
    const response = await routeSync(config)(get(`/sync${routes.pull}?user=u-1`), {});
    expect(await response?.json()).toEqual({ room: "u-1", path: routes.pull });
  });

  it("honours a custom base path", async () => {
    const response = await routeSync({ ...config, basePath: "/legation" })(
      get(`/legation${routes.push}?user=u-2`),
      {}
    );
    expect(await response?.json()).toEqual({ room: "u-2", path: routes.push });
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

/** A request a shard has answered: which shard (topic), which route, what body. */
interface ShardCall {
  readonly shard: string;
  readonly path: string;
  readonly body: { readonly roomId?: string; readonly topics?: ReadonlyArray<string> };
}

/**
 * Every shard request, recorded once the shard has answered it, and a way to
 * wait for one. A `/publish` answers only after it has poked each leased
 * room, so its completion means any poke it routed has landed.
 */
const makeShardCalls = () => {
  const calls: Array<ShardCall> = [];
  const waiters: Array<{
    readonly match: (call: ShardCall) => boolean;
    readonly done: () => void;
  }> = [];
  return {
    record: (call: ShardCall) => {
      calls.push(call);
      for (const waiter of waiters.filter((w) => w.match(call))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
    },
    /** How many calls have completed so far: a mark to pass to `next`. */
    count: () => calls.length,
    /**
     * Resolve once a matching call has completed, counting only calls after
     * the `since` mark (at once if one already has).
     */
    next: (match: (call: ShardCall) => boolean, since = 0): Promise<void> =>
      calls.slice(since).some(match)
        ? Promise.resolve()
        : new Promise<void>((done) => waiters.push({ match, done })),
  };
};

/** A ClientTransport calling a room instance's fetch directly. */
const roomTransport = (room: { fetch: (request: Request) => Promise<Response> }) => {
  const post = (route: string) => (body: unknown) =>
    Effect.promise(async () => {
      const response = await room.fetch(
        new Request(`https://room${route}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        })
      );
      return (await response.json()) as never;
    });
  return {
    push: post(routes.push),
    pull: post(routes.pull),
    read: post(routes.read),
    pokes: Stream.empty,
    status: Effect.succeed("connected" as const),
    statusChanges: Stream.succeed("connected" as const),
  } as Transport.ClientTransport;
};

describe("rooms + shards, end to end", () => {
  it("a cross-room write pokes the fine-registered room's sockets and window", async () => {
    // Shards stamp and check leases with `Date.now()`. Pinning it means a
    // lease cannot expire mid-test however late a heartbeat runs; expiry has
    // its own unit test above. Timers stay real, so heartbeats still fire.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const scope = Effect.runSync(Scope.make());
    try {
      const backend = await Effect.runPromise(
        MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(reviewSet, (args, writer) =>
              writer.put("reviews", (args as { id: string }).id, args)
            ),
          ])
        ).pipe(Scope.provide(scope))
      );

      // The two namespaces reference each other: shards poke rooms back.
      const rooms = new Map<string, InstanceType<ReturnType<typeof makeRoomClass<unknown>>>>();
      const shards = new Map<string, InstanceType<ReturnType<typeof makeShardClass<unknown>>>>();
      const roomsNs = makeNamespace(async (name, request) => {
        const room = rooms.get(name);
        return room === undefined ? new Response("no room", { status: 404 }) : room.fetch(request);
      });
      const shardCalls = makeShardCalls();
      const shardsNs = makeNamespace(async (name, request) => {
        let shard = shards.get(name);
        if (shard === undefined) {
          shard = new ShardClass(makeState(`shard:${name}`).state, {});
          shards.set(name, shard);
        }
        const body = (await request.clone().json()) as ShardCall["body"];
        const response = await shard.fetch(request);
        shardCalls.record({ shard: name, path: new URL(request.url).pathname, body });
        return response;
      });
      const ShardClass = makeShardClass<unknown>({ rooms: () => roomsNs });
      const RoomClass = makeRoomClass<unknown>({
        nodes,
        backend: () => backend,
        policy: () =>
          Authorization.policy({
            products: Authorization.allowAll,
            reviews: Authorization.allowAll,
          }),
        shards: () => shardsNs,
        heartbeat: "50 millis",
      });

      const roomA = makeState("room-a");
      const roomB = makeState("room-b");
      rooms.set("room-a", new RoomClass(roomA.state, {}));
      rooms.set("room-b", new RoomClass(roomB.state, {}));

      // Room A gets a hibernation-style socket (poke frames land here).
      // The `/socket` upgrade itself needs Workers globals (WebSocketPair,
      // 101 responses) that Node lacks, so the fake is accepted directly.
      const socketA: FakeSocket = {
        sent: [],
        send(data) {
          this.sent.push(data);
        },
      };
      roomA.state.acceptWebSocket(socketA as never);

      // A real client engine on room A observes p-1's reviews (fine window).
      const readerScope = Effect.runSync(Scope.make());
      const reader = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ClientStore.makeMemory;
          const engine = yield* ClientEngine.make({
            clientId: "client-a",
            clientGroupId: "group-a",
            mutators: mutations,
            syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 millis" },
          }).pipe(
            Effect.provideService(ClientStore.ClientStore, store),
            Effect.provideService(Transport.ClientTransport, roomTransport(rooms.get("room-a")!))
          );
          return engine;
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
      // A heartbeat leases the fine topic at its shard.
      await shardCalls.next(
        (call) =>
          call.shard === "reviews/productId=p-1" &&
          call.path === "/register" &&
          call.body.roomId === "room-a"
      );

      // Room B's client writes a p-1 review and pushes.
      const writerScope = Effect.runSync(Scope.make());
      const writer = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ClientStore.makeMemory;
          return yield* ClientEngine.make({
            clientId: "client-b",
            clientGroupId: "group-b",
            mutators: mutations,
          }).pipe(
            Effect.provideService(ClientStore.ClientStore, store),
            Effect.provideService(Transport.ClientTransport, roomTransport(rooms.get("room-b")!))
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

      // The shard poked room A: once the fine topic's publish is answered, its
      // socket has a contentless frame…
      await shardCalls.next(
        (call) => call.shard === "reviews/productId=p-1" && call.path === "/publish"
      );
      expect(socketA.sent.length).toBeGreaterThan(0);
      expect(JSON.parse(socketA.sent[0]!)).toEqual({ type: "poke" });
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
      // Both of the write's topics are published: the coarse one and the p-9
      // one. Once each publish is answered, any poke it routed has landed.
      await shardCalls.next((call) => call.shard === "reviews" && call.path === "/publish", before);
      await shardCalls.next(
        (call) => call.shard === "reviews/productId=p-9" && call.path === "/publish",
        before
      );
      expect(socketA.sent.length).toBe(sends);

      await Effect.runPromise(Scope.close(writerScope, Exit.void));
      await Effect.runPromise(Scope.close(readerScope, Exit.void));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      vi.useRealTimers();
    }
  }, 20_000);
});

describe("D1Executor", () => {
  it("declares no transactions, so SqlBackend keeps the handler-then-bump order (#342, #359)", () => {
    // A claim committed on its own would be skipped by a retry after a crash.
    expect(D1Executor.make({} as D1Database).transactional).toBe(false);
  });
});
