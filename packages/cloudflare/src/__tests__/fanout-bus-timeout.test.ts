/**
 * FanoutBus bounds each broker call it makes, at the `timeout` the room passes it (#379). A
 * publish runs inside the sync server's uninterruptible region, so a hung broker must be
 * dropped at that bound. TestClock moves the bound, not wall time.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Ref, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Node } from "@thomasfosterau/legation-effect";
import { FanoutBroker, FanoutBus } from "@thomasfosterau/legation-effect/internal";

const Product = Node.make("products", { attributes: { name: Schema.String } });
const nodes = Node.registry([Product]);

describe("FanoutBus broker bound (#379)", () => {
  it.effect("a hung broker publish is dropped at the timeout the bus was given", () =>
    Effect.gen(function* () {
      const broker: FanoutBroker.FanoutBroker = {
        register: () => Effect.void,
        publish: () => Effect.never,
        pokes: () => Effect.die(new Error("unused")),
      };
      const bus = yield* FanoutBus.make({
        roomId: "room-a",
        broker,
        nodes,
        subsets: Effect.succeed([]),
        timeout: "2 seconds",
      });
      const returned = yield* Ref.make(false);
      const publishing = yield* Effect.forkScoped(
        bus
          .publish([{ collection: "products", ids: ["p-1"] }])
          .pipe(Effect.andThen(Ref.set(returned, true))),
        { startImmediately: true }
      );
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(returned)).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(Exit.isSuccess(yield* Fiber.await(publishing))).toBe(true);
      expect(yield* Ref.get(returned)).toBe(true);
    }).pipe(Effect.scoped)
  );
});
