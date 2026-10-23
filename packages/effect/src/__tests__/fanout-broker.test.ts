/**
 * Topic-derived fan-out (ADR-0023): the pure topic algebra (fine topics
 * only from the derivable set; writes derive from old AND new values), the
 * broker's leased registrations (expiry drops silent rooms), and the
 * two-room end-to-end — a write on one room pokes another room's
 * fine-registered window across the broker, while a write to a different
 * parent leaves it silent (routing precision, not just delivery).
 *
 * The timed cases run under `it.effect`: lease expiry, the bus heartbeat and
 * the writer's push debounce read the `TestClock`, which only moves when a
 * test advances it, and each wait is for a specific event (a lease
 * registered, a write pushed, a publish routed, a window updated). Nothing
 * waits on wall-clock time, so a loaded machine cannot expire a lease or skip
 * a heartbeat mid-test (#282, #292).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
  Transport,
} from "../index.js";
import {
  ClientEngine,
  ClientView,
  Cvr,
  FanoutBroker,
  FanoutBus,
  FanoutTopics,
  InvalidationBus,
  Subset,
  SyncServer,
} from "../internal.js";
import { Backend } from "../index.js";
import * as Predicate from "../Predicate.js";
import { defined } from "./defined.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String },
  edges: { reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }) },
});
const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
  hintKeys: ["moderatorId"],
});
const nodes = Node.registry([Product, Review]);
const reviewDerivable = FanoutTopics.derivableSets(nodes).get("reviews");

describe("FanoutTopics", () => {
  it("registers the finest legal topic for a window", () => {
    // An equality conjunct on a derivable field → the fine topic.
    expect(
      FanoutTopics.topicForSubset(
        Subset.make({ collection: "reviews", where: Predicate.eq("productId", "p-1") }),
        reviewDerivable
      )
    ).toBe("reviews/productId=p-1");
    // Conjunctions qualify through their derivable equality.
    expect(
      FanoutTopics.topicForSubset(
        Subset.make({
          collection: "reviews",
          where: Predicate.and(Predicate.eq("body", "x"), Predicate.eq("productId", "p-1")),
        }),
        reviewDerivable
      )
    ).toBe("reviews/productId=p-1");
    // Hint keys are derivable too (ADR-0023).
    expect(
      FanoutTopics.topicForSubset(
        Subset.make({ collection: "reviews", where: Predicate.eq("moderatorId", "m-1") }),
        reviewDerivable
      )
    ).toBe("reviews/moderatorId=m-1");
    // Non-derivable equality, ranges, whole collections → coarse.
    expect(
      FanoutTopics.topicForSubset(
        Subset.make({ collection: "reviews", where: Predicate.eq("body", "x") }),
        reviewDerivable
      )
    ).toBe("reviews");
    expect(
      FanoutTopics.topicForSubset(
        Subset.make({ collection: "reviews", where: Predicate.gt("createdAt", "2026") }),
        reviewDerivable
      )
    ).toBe("reviews");
    expect(
      FanoutTopics.topicForSubset(Subset.make({ collection: "reviews" }), reviewDerivable)
    ).toBe("reviews");
  });

  it("derives write topics from old AND new values", () => {
    // A move between parents pokes both edges (plus coarse).
    expect(
      FanoutTopics.topicsForWrite("reviews", reviewDerivable, {
        oldValue: { id: "r-1", productId: "p-1" },
        newValue: { id: "r-1", productId: "p-2" },
      })
    ).toEqual(new Set(["reviews", "reviews/productId=p-1", "reviews/productId=p-2"]));
    // A delete derives from the old row alone.
    expect(
      FanoutTopics.topicsForWrite("reviews", reviewDerivable, {
        oldValue: { id: "r-1", productId: "p-1" },
      })
    ).toEqual(new Set(["reviews", "reviews/productId=p-1"]));
    // No values → coarse only (the sound degradation).
    expect(FanoutTopics.topicsForWrite("reviews", reviewDerivable, {})).toEqual(
      new Set(["reviews"])
    );
  });
});

/**
 * The batch waiting on a room's feed, or `undefined` when nothing is. `publish`
 * hands a match to the feed before it returns, so after a publish this tells
 * routed from not routed without waiting: a take forked here either finds the
 * batch at once or is still suspended once the test has yielded to it.
 */
const waitingPoke = (pokes: FanoutBroker.TopicPokes) =>
  Effect.gen(function* () {
    const taker = yield* Effect.forkChild(pokes.take);
    // Zero-length turns, not one: a routed batch is handed over within a few
    // scheduler turns however the taker is queued, and the clock does not move,
    // so a batch still missing after the bound is genuinely not routed.
    for (let turn = 0; turn < 50 && taker.pollUnsafe() === undefined; turn++) {
      yield* TestClock.adjust("0 millis");
    }
    const exit = taker.pollUnsafe();
    yield* Fiber.interrupt(taker);
    return exit !== undefined && Exit.isSuccess(exit) ? exit.value : undefined;
  });

describe("FanoutBroker leases", () => {
  it.effect("routes only intersecting topics; expired leases age out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* FanoutBroker.makeInProcess;
        const pokes = yield* broker.pokes("room-a");
        yield* broker.register("room-a", new Set(["reviews/productId=p-1"]), "150 millis");

        // A non-intersecting publish stays silent; an intersecting one lands.
        yield* broker.publish(["reviews/productId=p-2", "products"]);
        expect(yield* waitingPoke(pokes)).toBeUndefined();
        yield* broker.publish(["reviews/productId=p-1", "reviews"]);
        expect(yield* waitingPoke(pokes)).toEqual(["reviews/productId=p-1"]);

        // Up to the last instant of the TTL the lease still routes.
        yield* TestClock.adjust("149 millis");
        yield* broker.publish(["reviews/productId=p-1"]);
        expect(yield* waitingPoke(pokes)).toEqual(["reviews/productId=p-1"]);

        // At the TTL the lease is gone: publishes stop routing.
        yield* TestClock.adjust("1 millis");
        yield* broker.publish(["reviews/productId=p-1"]);
        expect(yield* waitingPoke(pokes)).toBeUndefined();
      })
    )
  );
});

// ─── Two rooms over one broker: precision end to end ─────────────────────────

// Advance the TestClock in 10 ms steps (a fifth of the rooms' heartbeat) until `read` satisfies `until`. Each `TestClock.adjust` yields to
// the forked fibres (engines, bus heartbeats, the server's fan-out loop) and
// fires the timers due by then. Time is virtual: the bound is a number of
// steps, not a wall-clock budget, so machine load cannot exhaust it, and
// 200 steps (2 s) stay far inside the clients' 10-minute pull interval.
const advanceUntil = <A>(read: Effect.Effect<A>, until: (value: A) => boolean, maxSteps = 200) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxSteps; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* TestClock.adjust(Duration.millis(10));
    }
    const value = yield* read;
    if (until(value)) return value;
    return yield* Effect.die(new Error(`advanceUntil: condition never held in ${maxSteps} steps`));
  });

/**
 * The broker, recording what reaches it: each room's latest registered topic
 * set, and every publish once it has returned (by then each match is already
 * in its room's poke feed).
 */
const observedBroker = (broker: FanoutBroker.FanoutBroker) =>
  Effect.gen(function* () {
    const registered = yield* Ref.make(new Map<string, ReadonlySet<string>>());
    const published = yield* Ref.make<ReadonlyArray<ReadonlySet<string>>>([]);
    const observed: FanoutBroker.FanoutBroker = {
      register: (roomId, topics, ttl) =>
        broker
          .register(roomId, topics, ttl)
          .pipe(
            Effect.tap(() => Ref.update(registered, (map) => new Map(map).set(roomId, topics)))
          ),
      publish: (topics) => {
        const all = new Set(topics);
        return broker
          .publish(all)
          .pipe(Effect.tap(() => Ref.update(published, (list) => [...list, all])));
      },
      pokes: broker.pokes,
    };
    return { broker: observed, registered, published };
  });

const reviewSet = Mutation.make("review/set", Schema.Unknown);
const mutations = Mutation.registry([
  {
    mutator: reviewSet,
    local: (args, writer) => writer.put("reviews", (args as { id: string }).id, args),
  },
]);

/** A per-user room: its own sync server + FanoutBus over the shared broker. */
const makeRoom = (roomId: string, backend: Backend.Backend, broker: FanoutBroker.FanoutBroker) =>
  Effect.gen(function* () {
    // Late binding: the bus needs the room's windows, which the handler's
    // introspection provides once built.
    const subsetsRef = yield* Ref.make<Effect.Effect<ReadonlyArray<Subset.Subset>>>(
      Effect.succeed([])
    );
    const bus = yield* FanoutBus.make({
      roomId,
      broker,
      nodes,
      subsets: Ref.get(subsetsRef).pipe(Effect.flatten),
      heartbeat: "50 millis",
    });
    const { handler, introspection } = yield* SyncServer.makeWithIntrospection.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ products: Authorization.allowAll, reviews: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
    yield* Ref.set(
      subsetsRef,
      introspection.groups.pipe(Effect.map((groups) => groups.flatMap((group) => group.subsets)))
    );
    return handler;
  });

/**
 * A room's handler, recording the review ids each push carried, in order, once
 * the room has applied it (and so published its topics to the broker).
 */
const recordPushes = (handler: Transport.ServerHandler) =>
  Effect.gen(function* () {
    const pushes = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const recorded: Transport.ServerHandler = {
      ...handler,
      handlePush: (request) =>
        handler
          .handlePush(request)
          .pipe(
            Effect.tap(() =>
              Ref.update(pushes, (all) => [
                ...all,
                request.mutations.map((mutation) => (mutation.args as { id: string }).id),
              ])
            )
          ),
    };
    return { handler: recorded, pushes };
  });

const makeRoomClient = (handler: Transport.ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStore.makeMemory;
    const transport = yield* Transport.makeInMemory(handler, group);
    const engine = yield* ClientEngine.make({
      clientId: `client-${group}`,
      clientGroupId: group,
      mutators: mutations,
      syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 millis" },
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    yield* Effect.forkScoped(engine.runSync.pipe(Effect.orDie));
    return { engine, client: Client.fromView(nodes, ClientView.fromEngine(engine)) };
  });

describe("two rooms over one broker", () => {
  it.effect("a foreign write pokes the fine-registered room; other parents stay silent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(reviewSet, (args, writer) =>
              writer.put("reviews", (args as { id: string }).id, args)
            ),
          ])
        );
        const { broker, registered, published } = yield* observedBroker(
          yield* FanoutBroker.makeInProcess
        );
        // Every poke routed to room A, read off its feed by a probe of our own.
        const roomAPokes = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const probe = yield* broker.pokes("room-a");
        yield* Effect.forkScoped(
          Effect.forever(
            probe.take.pipe(
              Effect.flatMap((topics) => Ref.update(roomAPokes, (all) => [...all, topics]))
            )
          )
        );
        const roomA = yield* makeRoom("room-a", backend, broker);
        const roomB = yield* recordPushes(yield* makeRoom("room-b", backend, broker));

        // Room A's user watches product p-1's reviews (a fine-topic window).
        const reader = yield* makeRoomClient(roomA, "group-a");
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        const emissions = yield* Ref.make(0);
        yield* Effect.forkScoped(
          Stream.runForEach(
            reader.client.observe({ collection: "reviews", where: { productId: "p-1" } }),
            (rows) =>
              Ref.set(latest, rows).pipe(Effect.andThen(Ref.update(emissions, (n) => n + 1)))
          ).pipe(Effect.ignore)
        );
        // The observer's first emission means its window is subscribed. A pull
        // then registers the window; a heartbeat leases its fine topic.
        yield* advanceUntil(Ref.get(emissions), (n) => n > 0);
        yield* reader.engine.pull.pipe(Effect.orDie);
        yield* advanceUntil(
          Ref.get(registered),
          (rooms) => rooms.get("room-a")?.has("reviews/productId=p-1") === true
        );

        // Room B's user writes a p-1 review: fine topic → room A → poke → pull.
        // Nothing pushes explicitly: the writer's sync loop carries each write
        // to room B. r-1 is journaled before the writer's forked `runSync` has
        // run, so its connect leg pushes it; r-2 comes after start-up, and only
        // the push debounce can push it. Before #317 was fixed, the debounce
        // subscribed to its trigger a few scheduler turns too late and r-2 was
        // never pushed. That regression guard relies on the waits below
        // returning without a further clock advance before r-2 is written: a
        // `TestClock.adjust` in between gives the debounce time to subscribe
        // and lets the pre-#317 engine pass.
        const writer = yield* makeRoomClient(roomB.handler, "group-b");
        yield* writer.client.mutate("review/set", {
          id: "r-1",
          body: "cross-room",
          createdAt: "2026-01-01",
          productId: "p-1",
        });
        yield* advanceUntil(Ref.get(roomB.pushes), (pushes) => Arr.isReadonlyArrayNonEmpty(pushes));
        const rows = yield* advanceUntil(Ref.get(latest), (current) => current.length === 1);
        expect((defined(rows[0]).value as { body: string }).body).toBe("cross-room");
        expect(yield* Ref.get(roomAPokes)).toEqual([["reviews/productId=p-1"]]);

        // A write to ANOTHER parent must not poke room A (routing precision):
        // once the debounce has pushed it and room B has published it (and the
        // probe has had a turn to read anything routed), room A has still had
        // only the p-1 poke, and its window one row.
        yield* writer.client.mutate("review/set", {
          id: "r-2",
          body: "other parent",
          createdAt: "2026-01-02",
          productId: "p-9",
        });
        yield* advanceUntil(Ref.get(roomB.pushes), (pushes) => pushes.length > 1);
        expect(
          (yield* Ref.get(published)).some((topics) => topics.has("reviews/productId=p-9"))
        ).toBe(true);
        // Two debounce windows later nothing more has been pushed: each write
        // went to room B exactly once.
        yield* TestClock.adjust(Duration.millis(20));
        expect(yield* Ref.get(roomB.pushes)).toEqual([["r-1"], ["r-2"]]);
        expect(yield* Ref.get(roomAPokes)).toEqual([["reviews/productId=p-1"]]);
        expect(yield* Ref.get(latest)).toHaveLength(1);
      })
    )
  );
});
