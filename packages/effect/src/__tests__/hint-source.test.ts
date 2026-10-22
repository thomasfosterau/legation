/**
 * HintSource (#43): `fromStream` forks a scoped fibre that publishes each hint
 * batch it takes off the stream to the in-context InvalidationBus, and stops
 * when the scope closes.
 *
 * Both cases run on the TestClock and wait on events, never on a timer. The
 * stop case awaits the consumer's own teardown (a finalizer on its stream), and
 * proves a later offer never reaches the bus with a sentinel hint that must
 * arrive first.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ChangeHint } from "../Backend.js";
import * as HintSource from "../HintSource.js";
import * as InvalidationBus from "../InvalidationBus.js";

describe("HintSource.fromStream (#43)", () => {
  it.effect("publishes each hint batch from the stream to the bus", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      // Subscribe before running so no batch is missed.
      const subscription = yield* bus.subscribe;
      const batches: ReadonlyArray<ReadonlyArray<ChangeHint>> = [
        [{ collection: "todos", ids: ["1"] }],
        [{ collection: "lists", ids: [] }],
      ];

      yield* HintSource.run(HintSource.fromStream(Stream.fromIterable(batches))).pipe(
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      expect(yield* subscription.take).toEqual(batches[0]);
      expect(yield* subscription.take).toEqual(batches[1]);
    }).pipe(Effect.scoped)
  );

  it.effect("stops publishing when its scope closes", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      const subscription = yield* bus.subscribe;
      const queue = yield* Queue.unbounded<ReadonlyArray<ChangeHint>>();
      // Completes when the consumer's stream is finalized, which happens exactly
      // when its fibre is interrupted.
      const stopped = yield* Deferred.make<void>();
      const source = Stream.fromQueue(queue).pipe(
        Stream.ensuring(Deferred.succeed(stopped, undefined).pipe(Effect.asVoid))
      );

      // Run the source inside an inner scope; when that scope closes, the forked
      // consumer fibre is interrupted.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* HintSource.run(HintSource.fromStream(source)).pipe(
            Effect.provideService(InvalidationBus.InvalidationBus, bus)
          );
          yield* Queue.offer(queue, [{ collection: "todos", ids: ["1"] }]);
          expect(yield* subscription.take).toEqual([{ collection: "todos", ids: ["1"] }]);
        })
      );
      yield* Deferred.await(stopped);

      // The consumer is gone, which `stopped` proves: the stream's finalizer runs
      // only after the consumer's in-flight publish, if any, has finished. This
      // part checks the effect: a later offer never reaches the bus. The yields
      // give a still-running consumer the chance to publish the offer before
      // the sentinel; without them the sentinel would win the race either way.
      yield* Queue.offer(queue, [{ collection: "todos", ids: ["2"] }]);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      const sentinel: ReadonlyArray<ChangeHint> = [{ collection: "lists", ids: ["sentinel"] }];
      yield* bus.publish(sentinel);
      expect(yield* subscription.take).toEqual(sentinel);
    }).pipe(Effect.scoped)
  );
});
