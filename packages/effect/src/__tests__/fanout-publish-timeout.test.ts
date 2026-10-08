/**
 * A hung broker cannot hold the publish open (#356 follow-up). `SyncServer.handlePush`
 * runs `bus.publish` inside an uninterruptible region, so the bus bounds each broker
 * call itself: a publish that never returns is dropped at its timeout, and the lease
 * refresh that follows it still runs. Time is the TestClock, so the bound is crossed by
 * advancing virtual time, not by waiting.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Ref, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Node } from "../index.js";
import { FanoutBroker, FanoutBus } from "../internal.js";

const Product = Node.make("products", { attributes: { name: Schema.String } });
const nodes = Node.registry([Product]);

describe("FanoutBus broker timeouts (#356)", () => {
  it.effect(
    "a hung broker publish is dropped at its bound, inside the uninterruptible region",
    () =>
      Effect.gen(function* () {
        const registrations = yield* Ref.make(0);
        const broker: FanoutBroker.FanoutBroker = {
          register: () => Ref.update(registrations, (count) => count + 1),
          // Never returns: only the bound can finish this publish.
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
        // The region as the sync server holds it while it publishes.
        const publishing = yield* Effect.forkScoped(
          Effect.uninterruptible(bus.publish([{ collection: "products", ids: ["p-1"] }])),
          { startImmediately: true }
        );
        yield* TestClock.adjust("2 seconds");
        const exit = yield* Fiber.await(publishing);
        expect(Exit.isSuccess(exit)).toBe(true);
        // The lease refresh after the dropped publish ran: the initial registration
        // at make, plus the one that follows the publish.
        expect(yield* Ref.get(registrations)).toBe(2);
      }).pipe(Effect.scoped)
  );
});
