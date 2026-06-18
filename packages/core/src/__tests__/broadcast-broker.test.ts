/**
 * BroadcastChannel BusBroker: two brokers on the same channel name exchange
 * payloads (cross-context), and a publisher's own subscriber sees its payload
 * (self-delivery, which BroadcastChannel itself omits for the sender).
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as BusBrokers from "../BusBrokers.js";

const asLike = (channel: BroadcastChannel) => channel as unknown as BusBrokers.BroadcastChannelLike;

describe("makeBroadcastChannelBroker", () => {
  it("delivers to self and to other contexts on the same channel", async () => {
    const channelA = new BroadcastChannel("effect-sync-bus-test");
    const channelB = new BroadcastChannel("effect-sync-bus-test");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const brokerA = yield* BusBrokers.makeBroadcastChannelBroker(asLike(channelA));
          const brokerB = yield* BusBrokers.makeBroadcastChannelBroker(asLike(channelB));
          const subA = yield* brokerA.subscribe;
          const subB = yield* brokerB.subscribe;

          yield* brokerA.publish("hint-1");
          expect(yield* subA.take).toBe("hint-1"); // self-delivery
          expect(yield* subB.take).toBe("hint-1"); // cross-context delivery
        }).pipe(Effect.scoped)
      );
    } finally {
      channelA.close();
      channelB.close();
    }
  });
});
