/**
 * HintSource (#43): `fromStream` forks a scoped fibre that publishes each hint
 * batch it takes off the stream to the in-context InvalidationBus, and stops
 * when the scope closes.
 *
 * The consumer runs on a forked fibre, so the "stops on scope close" case uses
 * `it.live` (wall time) and a real-timer race to a timeout, mirroring
 * `fanout-matching.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import type { ChangeHint } from "../Backend.js";
import * as HintSource from "../HintSource.js";
import * as InvalidationBus from "../InvalidationBus.js";

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

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

  it.live("stops publishing when its scope closes", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      const subscription = yield* bus.subscribe;
      const queue = yield* Queue.unbounded<ReadonlyArray<ChangeHint>>();

      // Run the source inside an inner scope; when that scope closes, the forked
      // consumer fibre is interrupted.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* HintSource.run(HintSource.fromStream(Stream.fromQueue(queue))).pipe(
            Effect.provideService(InvalidationBus.InvalidationBus, bus)
          );
          yield* Queue.offer(queue, [{ collection: "todos", ids: ["1"] }]);
          expect(yield* subscription.take).toEqual([{ collection: "todos", ids: ["1"] }]);
        })
      );

      // The consumer is gone: a later offer never reaches the bus.
      yield* Queue.offer(queue, [{ collection: "todos", ids: ["2"] }]);
      const outcome = yield* Effect.race(
        subscription.take.pipe(Effect.as("published" as const)),
        sleepReal(30).pipe(Effect.as("quiet" as const))
      );
      expect(outcome).toBe("quiet");
    }).pipe(Effect.scoped)
  );
});
