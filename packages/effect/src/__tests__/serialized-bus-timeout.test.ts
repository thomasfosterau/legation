/**
 * A hung custom broker cannot hold the publish open (#375). `SyncServer.handlePush`
 * runs `bus.publish` inside an uninterruptible region, and `makeSerialized` runs the
 * bus over a caller's `BusBroker`, so the bus bounds the broker's publish itself: a
 * publish that never returns is logged and dropped at its timeout (ADR-0009). Time is
 * the TestClock, so the bound is crossed by advancing virtual time, not by waiting.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as InvalidationBus from "../InvalidationBus.js";

const hint = { collection: "todos", ids: ["1"] };

/** A custom broker whose publish never returns: only the bus's bound can finish it. */
const hungBroker: InvalidationBus.BusBroker = {
  publish: () => Effect.never,
  subscribe: Effect.die(new Error("unused")),
};

describe("makeSerialized broker publish timeout (#375)", () => {
  it.effect(
    "a hung broker publish is dropped and logged at its bound, inside the uninterruptible region",
    () => {
      const logged: Array<string> = [];
      const collector = Logger.make(({ message }) => {
        logged.push(String(message));
      });
      return Effect.gen(function* () {
        const bus = InvalidationBus.makeSerialized(hungBroker, { timeout: "2 seconds" });
        const returned = yield* Ref.make(false);
        // The region as the sync server holds it while it publishes.
        yield* Effect.forkScoped(
          Effect.uninterruptible(bus.publish([hint]).pipe(Effect.andThen(Ref.set(returned, true)))),
          { startImmediately: true }
        );
        yield* TestClock.adjust("2 seconds");
        expect(yield* Ref.get(returned)).toBe(true);
        expect(logged.some((line) => line.includes("timed out"))).toBe(true);
      }).pipe(Effect.scoped, Effect.withLogger(collector));
    }
  );

  it.effect("the bound defaults to 5 seconds when no timeout is passed", () =>
    Effect.gen(function* () {
      const bus = InvalidationBus.makeSerialized(hungBroker);
      const returned = yield* Ref.make(false);
      yield* Effect.forkScoped(
        Effect.uninterruptible(bus.publish([hint]).pipe(Effect.andThen(Ref.set(returned, true)))),
        { startImmediately: true }
      );
      yield* TestClock.adjust("4 seconds");
      expect(yield* Ref.get(returned)).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(returned)).toBe(true);
    }).pipe(Effect.scoped)
  );
});
