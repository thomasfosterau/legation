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
import * as TestClock from "effect/testing/TestClock";
import { FanoutTopics } from "@thomasfosterau/legation/internal";
import * as DurableFanoutBroker from "../DurableFanoutBroker.js";
import type * as FanoutShard from "../FanoutShard.js";
import { fakeBinding, runtimeContext } from "./harness.js";

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
                : Effect.die(new Error("RpcCallError")),
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
