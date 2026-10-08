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

  it.effect("the publish bound defaults to 5 seconds when no timeout is passed", () =>
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
      });
      const returned = yield* Ref.make(false);
      yield* Effect.forkScoped(
        Effect.uninterruptible(
          bus
            .publish([{ collection: "products", ids: ["p-1"] }])
            .pipe(Effect.andThen(Ref.set(returned, true)))
        ),
        { startImmediately: true }
      );
      yield* TestClock.adjust("4 seconds");
      expect(yield* Ref.get(returned)).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(returned)).toBe(true);
    }).pipe(Effect.scoped)
  );

  // The lease registration at make is bounded too: a hung broker.register must not
  // keep FanoutBus.make (and so the room's construction) from completing.
  it.effect("a hung lease registration at make is dropped at its bound, so make completes", () =>
    Effect.gen(function* () {
      const broker: FanoutBroker.FanoutBroker = {
        register: () => Effect.never,
        publish: () => Effect.void,
        pokes: () => Effect.die(new Error("unused")),
      };
      const made = yield* Ref.make(false);
      yield* Effect.forkScoped(
        FanoutBus.make({
          roomId: "room-a",
          broker,
          nodes,
          subsets: Effect.succeed([]),
          timeout: "2 seconds",
        }).pipe(Effect.andThen(Ref.set(made, true))),
        { startImmediately: true }
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* Ref.get(made)).toBe(true);
    }).pipe(Effect.scoped)
  );

  // A heartbeat's hung registration is dropped at its bound too, so the heartbeat
  // keeps renewing: the third registration starts one heartbeat after the second is dropped.
  it.effect(
    "a hung heartbeat registration is dropped at its bound, and the heartbeat goes on",
    () =>
      Effect.gen(function* () {
        const registrations = yield* Ref.make(0);
        const broker: FanoutBroker.FanoutBroker = {
          register: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(registrations, (count) => count + 1);
              // The registration at make succeeds; every heartbeat after it hangs.
              if (attempt > 1) return yield* Effect.never;
            }),
          publish: () => Effect.void,
          pokes: () => Effect.die(new Error("unused")),
        };
        yield* FanoutBus.make({
          roomId: "room-a",
          broker,
          nodes,
          subsets: Effect.succeed([]),
          heartbeat: "10 seconds",
          timeout: "5 seconds",
        });
        // t=10: the first heartbeat registers and hangs; t=15: its bound drops it;
        // t=25: the next heartbeat starts.
        yield* TestClock.adjust("10 seconds");
        expect(yield* Ref.get(registrations)).toBe(2);
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("10 seconds");
        expect(yield* Ref.get(registrations)).toBe(3);
      }).pipe(Effect.scoped)
  );
});
