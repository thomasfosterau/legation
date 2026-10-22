/**
 * BroadcastChannel BusBroker: two brokers on the same channel name exchange
 * payloads (cross-context), and a publisher's own subscriber sees its payload
 * (self-delivery, which BroadcastChannel itself omits for the sender).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as BusBrokers from "../BusBrokers.js";

const openChannel = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new BroadcastChannel(name)),
    (channel) => Effect.sync(() => channel.close())
  );

describe("makeBroadcastChannelBroker", () => {
  it.live("delivers to self and to other contexts on the same channel", () =>
    Effect.gen(function* () {
      const channelA: BusBrokers.BroadcastChannelLike = yield* openChannel("legation-bus-test");
      const channelB: BusBrokers.BroadcastChannelLike = yield* openChannel("legation-bus-test");
      const brokerA = yield* BusBrokers.makeBroadcastChannelBroker(channelA);
      const brokerB = yield* BusBrokers.makeBroadcastChannelBroker(channelB);
      const subA = yield* brokerA.subscribe;
      const subB = yield* brokerB.subscribe;

      yield* brokerA.publish("hint-1");
      expect(yield* subA.take).toBe("hint-1"); // self-delivery
      expect(yield* subB.take).toBe("hint-1"); // cross-context delivery
    }).pipe(Effect.scoped)
  );
});
