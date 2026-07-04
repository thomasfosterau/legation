/**
 * Topic-derived fan-out (ADR-0023): the pure topic algebra (fine topics
 * only from the derivable set; writes derive from old AND new values), the
 * broker's leased registrations (expiry drops silent rooms), and the
 * two-room end-to-end — a write on one room pokes another room's
 * fine-registered window across the broker, while a write to a different
 * parent leaves it silent (routing precision, not just delivery).
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
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

describe("FanoutBroker leases", () => {
  it.live("routes only intersecting topics; expired leases age out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* FanoutBroker.makeInProcess;
        const pokes = yield* broker.pokes("room-a");
        yield* broker.register("room-a", new Set(["reviews/productId=p-1"]), "150 millis");

        // A non-intersecting publish stays silent; an intersecting one lands.
        yield* broker.publish(["reviews/productId=p-2", "products"]);
        yield* broker.publish(["reviews/productId=p-1", "reviews"]);
        expect(yield* pokes.take).toEqual(["reviews/productId=p-1"]);

        // Past the TTL the lease is gone: publishes stop routing.
        yield* Effect.sleep("250 millis");
        yield* broker.publish(["reviews/productId=p-1"]);
        const raced = yield* Effect.raceFirst(
          pokes.take.pipe(Effect.map(() => "poked" as const)),
          Effect.sleep("150 millis").pipe(Effect.as("silent" as const))
        );
        expect(raced).toBe("silent");
      })
    )
  );
});

// ─── Two rooms over one broker: precision end to end ─────────────────────────

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
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
  it.live("a foreign write pokes the fine-registered room; other parents stay silent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* MemoryBackend.make(
          MemoryBackend.validatedHandlers([
            MemoryBackend.handler(reviewSet, (args, writer) =>
              writer.put("reviews", (args as { id: string }).id, args)
            ),
          ])
        );
        const broker = yield* FanoutBroker.makeInProcess;
        const roomA = yield* makeRoom("room-a", backend, broker);
        const roomB = yield* makeRoom("room-b", backend, broker);

        // Room A's user watches product p-1's reviews (a fine-topic window).
        const reader = yield* makeRoomClient(roomA, "group-a");
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            reader.client.observe({ collection: "reviews", where: { productId: "p-1" } }),
            (rows) => Ref.set(latest, rows)
          ).pipe(Effect.ignore)
        );
        // A pull registers the window; a heartbeat leases its fine topic.
        yield* eventually(Ref.get(latest), () => true);
        yield* reader.engine.pull.pipe(Effect.orDie);
        yield* sleepReal(120);

        // Room B's user writes a p-1 review: fine topic → room A → poke → pull.
        const writer = yield* makeRoomClient(roomB, "group-b");
        yield* writer.client.mutate("review/set", {
          id: "r-1",
          body: "cross-room",
          createdAt: "2026-01-01",
          productId: "p-1",
        });
        const rows = yield* eventually(Ref.get(latest), (current) => current.length === 1);
        expect((rows[0]!.value as { body: string }).body).toBe("cross-room");

        // A write to ANOTHER parent must not poke room A (routing precision):
        // its window stays at one row through the quiet period.
        yield* writer.client.mutate("review/set", {
          id: "r-2",
          body: "other parent",
          createdAt: "2026-01-02",
          productId: "p-9",
        });
        yield* sleepReal(250);
        expect(yield* Ref.get(latest)).toHaveLength(1);
      })
    )
  );
});
