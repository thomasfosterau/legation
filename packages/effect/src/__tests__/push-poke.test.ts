/**
 * Web Push as a poke carrier, the server side (#214): `PushPoke.sink` sends
 * the contentless marker to the targets the app's registry names, at most once
 * per coalescing window plus one trailing push, and never past the app's
 * budget. Time is the test clock.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { Touched } from "../HttpCache.js";
import * as PushPoke from "../PushPoke.js";

interface Device {
  readonly endpoint: string;
}

const alice: Device = { endpoint: "https://push.example/alice" };
const bob: Device = { endpoint: "https://push.example/bob" };

const touched: Touched = {
  collections: ["medical-records"],
  rows: [{ collection: "medical-records", id: "visit-42" }],
};

class PushFailed extends Schema.TaggedError<PushFailed>()("PushFailed", {}) {}

/** A sink over a fixed registry, recording every push it sends. */
const recording = (
  options: Partial<PushPoke.SinkOptions<Device>> & {
    readonly targets?: ReadonlyArray<Device>;
  } = {}
) =>
  Effect.gen(function* () {
    const sent: Array<{ readonly endpoint: string; readonly payload: string }> = [];
    const sink = yield* PushPoke.sink<Device>({
      targetsFor: () => Effect.succeed(options.targets ?? [alice]),
      keyOf: (device) => device.endpoint,
      send: (device, payload) =>
        Effect.sync(() => void sent.push({ endpoint: device.endpoint, payload })),
      coalesce: "1 minute",
      budget: { pushes: 10, per: "1 hour" },
      ...options,
    });
    return { sink, sent };
  });

describe("PushPoke.sink (#214)", () => {
  it.effect("sends the contentless marker to every target the registry names", () =>
    Effect.gen(function* () {
      const { sink, sent } = yield* recording({ targets: [alice, bob, alice] });
      yield* sink.invalidate(touched);
      expect(sent.map((push) => push.endpoint).toSorted()).toEqual([alice.endpoint, bob.endpoint]);
      sent.forEach((push) => {
        expect(push.payload).toBe(PushPoke.payload);
        // Nothing about the change crosses the push service.
        expect(push.payload).not.toMatch(/medical|visit|42/);
      });
      expect(PushPoke.isPoke(PushPoke.payload)).toBe(true);
    })
  );

  it.effect("coalesces a burst into one push now and one at the window's end", () =>
    Effect.gen(function* () {
      const { sink, sent } = yield* recording();
      yield* sink.invalidate(touched);
      yield* sink.invalidate(touched);
      yield* sink.invalidate(touched);
      expect(sent).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(sent).toHaveLength(2);
      // A change after the window is pushed at once again.
      yield* TestClock.adjust("2 minutes");
      yield* sink.invalidate(touched);
      expect(sent).toHaveLength(3);
    })
  );

  it.effect("sends nothing past the budget until its period moves on", () =>
    Effect.gen(function* () {
      const { sink, sent } = yield* recording({
        coalesce: "1 second",
        budget: { pushes: 2, per: "1 hour" },
      });
      // One change a minute for four minutes.
      yield* Effect.forEach(
        Arr.range(1, 4),
        () => sink.invalidate(touched).pipe(Effect.andThen(TestClock.adjust("1 minute"))),
        { concurrency: 1, discard: true }
      );
      expect(sent).toHaveLength(2);
      yield* TestClock.adjust("1 hour");
      yield* sink.invalidate(touched);
      expect(sent).toHaveLength(3);
    })
  );

  it.effect("never fails on a failing registry or push service", () =>
    Effect.gen(function* () {
      const failingRegistry = yield* recording({ targetsFor: () => Effect.fail(new PushFailed()) });
      yield* failingRegistry.sink.invalidate(touched);
      expect(failingRegistry.sent).toEqual([]);
      const failingSend = yield* recording({ send: () => Effect.fail(new PushFailed()) });
      yield* failingSend.sink.invalidate(touched);
    })
  );
});
