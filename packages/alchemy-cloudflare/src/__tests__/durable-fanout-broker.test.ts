/**
 * DurableFanoutBroker's shard calls (publishes and lease registrations) are
 * bounded (#356 follow-up). A publish runs inside the sync server's
 * uninterruptible region, so a shard that never answers must be dropped at the
 * timeout rather than hold the region open. Alchemy's RPC stubs take no abort
 * signal, so a dropped call is abandoned, not aborted; the fake shard records
 * the interruption of its call. TestClock moves the bound, not wall time.
 */
import { describe, expect, it } from "@effect/vitest";
import type * as Workers from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Edge, Node } from "@thomasfosterau/legation";
import { FanoutTopics } from "@thomasfosterau/legation/internal";
import * as DurableFanoutBroker from "../DurableFanoutBroker.js";
import type * as FanoutShard from "../FanoutShard.js";
import { fakeBinding, runtimeContext } from "./harness.js";
import { TestFailure } from "./test-failure.js";

/** Shards whose every call hangs, recording the topic of each call given up on. */
const hungShards = () => {
  const abandoned: Array<string> = [];
  const hang = (topic: string) =>
    Effect.onInterrupt(Effect.never, () => Effect.sync(() => void abandoned.push(topic)));
  const shards = fakeBinding<Workers.DurableObject<FanoutShard.ShardObject>>({
    getByName: (topic: string) => ({ register: () => hang(topic), publish: () => hang(topic) }),
  });
  return { shards, abandoned };
};

const makeBroker = (
  shards: Workers.DurableObject<FanoutShard.ShardObject>,
  poke: DurableFanoutBroker.MakeOptions["poke"] = () => Effect.void
) =>
  DurableFanoutBroker.make({ shards, poke, timeout: "3 seconds" }).pipe(
    Effect.provideService(RuntimeContext, runtimeContext)
  );

describe("DurableFanoutBroker shard calls (#356)", () => {
  it.effect("a hung shard call is dropped at its timeout, so the publish returns", () =>
    Effect.gen(function* () {
      const { shards, abandoned } = hungShards();
      const { broker } = yield* makeBroker(shards);
      const publishing = yield* Effect.forkScoped(
        broker.publish([FanoutTopics.coarse("products")]),
        { startImmediately: true }
      );
      yield* TestClock.adjust("3 seconds");
      expect(Exit.isSuccess(yield* Fiber.await(publishing))).toBe(true);
      expect(abandoned).toEqual(["products"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "a hung lease registration is dropped at its timeout, so the registration returns",
    () =>
      Effect.gen(function* () {
        const { shards, abandoned } = hungShards();
        const { broker } = yield* makeBroker(shards);
        const registering = yield* Effect.forkScoped(
          broker.register("room-a", new Set([FanoutTopics.coarse("products")]), "30 seconds"),
          { startImmediately: true }
        );
        yield* TestClock.adjust("3 seconds");
        expect(Exit.isSuccess(yield* Fiber.await(registering))).toBe(true);
        expect(abandoned).toEqual(["products"]);
      }).pipe(Effect.scoped)
  );
});

describe("DurableFanoutBroker publish", () => {
  it.effect(
    "pokes each leased room once, with every topic it matched, and drops a failed shard",
    () =>
      Effect.gen(function* () {
        const leased: Record<string, ReadonlyArray<string>> = {
          products: ["room-a", "room-b"],
          "products/categoryId=c-1": ["room-a"],
        };
        const shards = fakeBinding<Workers.DurableObject<FanoutShard.ShardObject>>({
          getByName: (topic: string) => ({
            register: () => Effect.void,
            // A failed RPC fails the stub's effect, whatever its types say.
            publish: () =>
              topic in leased
                ? Effect.succeed(leased[topic])
                : Effect.die(new TestFailure({ message: "RpcCallError" })),
          }),
        });
        const poked: Array<readonly [string, ReadonlyArray<string>]> = [];
        const { broker } = yield* makeBroker(shards, (roomId, topics) =>
          Effect.sync(() => void poked.push([roomId, topics]))
        );
        yield* broker.publish(["products", "products/categoryId=c-1", "broken"]);
        expect(poked.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
          ["room-a", ["products", "products/categoryId=c-1"]],
          ["room-b", ["products"]],
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect("notify feeds the room's poke subscribers", () =>
    Effect.gen(function* () {
      const { broker, notify } = yield* makeBroker(hungShards().shards);
      const pokes = yield* broker.pokes("room-a");
      yield* notify([FanoutTopics.coarse("products")]);
      expect(yield* pokes.take).toEqual([FanoutTopics.coarse("products")]);
    }).pipe(Effect.scoped)
  );
});

const nodes = Node.registry([
  Node.make("products", { attributes: { name: Schema.String } }),
  Node.make("reviews", {
    attributes: { body: Schema.String },
    edges: { product: Edge.one("products", { via: "productId" }) },
  }),
]);

/** Shards answering `leased[topic]`, and a room namespace recording each poke (or hanging on one). */
const outOfBand = (leased: Record<string, ReadonlyArray<string>>, hungRoom?: string) => {
  const published: Array<string> = [];
  const poked: Array<readonly [string, ReadonlyArray<string>]> = [];
  const shards = fakeBinding<Workers.DurableObject<FanoutShard.ShardObject>>({
    getByName: (topic: string) => ({
      register: () => Effect.void,
      publish: () =>
        Effect.sync(() => {
          published.push(topic);
          return leased[topic] ?? [];
        }),
    }),
  });
  const rooms = fakeBinding<Workers.DurableObject<DurableFanoutBroker.PokeSurface>>({
    getByName: (roomId: string) => ({
      poke: (topics: ReadonlyArray<string>) =>
        roomId === hungRoom ? Effect.never : Effect.sync(() => void poked.push([roomId, topics])),
    }),
  });
  const publish = DurableFanoutBroker.publishOutOfBand({
    shards,
    rooms,
    nodes,
    timeout: "3 seconds",
  });
  return {
    published,
    poked,
    publish: (hints: Parameters<typeof publish>[0]) =>
      publish(hints).pipe(Effect.provideService(RuntimeContext, runtimeContext)),
  };
};

describe("DurableFanoutBroker.publishOutOfBand", () => {
  it.effect(
    "derives a room's topics from the hints and pokes each leased room through the room namespace",
    () =>
      Effect.gen(function* () {
        const { published, poked, publish } = outOfBand({
          reviews: ["room-coarse"],
          "reviews/productId=p-1": ["room-fine"],
          "reviews/productId=p-2": ["room-moved-from"],
        });
        yield* publish([
          {
            collection: "reviews",
            ids: ["r-1"],
            values: [{ id: "r-1", value: { body: "new", productId: "p-1" } }],
            oldValues: [{ id: "r-1", value: { body: "old", productId: "p-2" } }],
          },
        ]);
        expect(published.toSorted()).toEqual([
          "reviews",
          "reviews/productId=p-1",
          "reviews/productId=p-2",
        ]);
        expect(poked.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
          ["room-coarse", ["reviews"]],
          ["room-fine", ["reviews/productId=p-1"]],
          ["room-moved-from", ["reviews/productId=p-2"]],
        ]);
      })
  );

  it.effect("a hint without values publishes its collection's coarse topic only", () =>
    Effect.gen(function* () {
      const { published, poked, publish } = outOfBand({
        reviews: ["room-coarse"],
        "reviews/productId=p-1": ["room-fine"],
      });
      yield* publish([{ collection: "reviews", ids: [] }]);
      expect(published).toEqual(["reviews"]);
      expect(poked).toEqual([["room-coarse", ["reviews"]]]);
    })
  );

  it.effect("a hung room poke is dropped at the timeout, so the publish returns", () =>
    Effect.gen(function* () {
      const { poked, publish } = outOfBand({ products: ["room-hung", "room-ok"] }, "room-hung");
      const publishing = yield* Effect.forkScoped(publish([{ collection: "products", ids: [] }]), {
        startImmediately: true,
      });
      yield* TestClock.adjust("3 seconds");
      expect(Exit.isSuccess(yield* Fiber.await(publishing))).toBe(true);
      expect(poked).toEqual([["room-ok", ["products"]]]);
    }).pipe(Effect.scoped)
  );
});
