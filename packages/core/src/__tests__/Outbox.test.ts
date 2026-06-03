import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Outbox from "../Outbox.js";

const testLayer = () => Outbox.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("Outbox", () => {
  it.effect("enqueues entries and lists them oldest first", () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.Outbox;
      yield* outbox.enqueue(["todos", "create"], { title: "first" });
      yield* outbox.enqueue(["todos", "create"], { title: "second" });
      const entries = yield* outbox.entries;

      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => (entry.input as { title: string }).title)).toEqual([
        "first",
        "second",
      ]);
    }).pipe(Effect.provide(testLayer()))
  );

  it.effect("drains entries, removing delivered ones", () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.Outbox;
      yield* outbox.enqueue(["a"], 1);
      yield* outbox.enqueue(["b"], 2);

      const drain = yield* outbox.drain(() => Effect.succeed("ok"));
      const remaining = yield* outbox.size;

      expect(drain.completed).toBe(2);
      expect(drain.failed).toBe(0);
      expect(remaining).toBe(0);
    }).pipe(Effect.provide(testLayer()))
  );

  it.effect("keeps failed entries for the next drain", () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.Outbox;
      yield* outbox.enqueue(["a"], 1);

      const drain = yield* outbox.drain(() => Effect.fail("delivery failed"));
      const entries = yield* outbox.entries;

      expect(drain.failed).toBe(1);
      expect(drain.remaining).toBe(1);
      expect(entries[0]?.status).toBe("failed");
      expect(entries[0]?.attempts).toBe(1);
    }).pipe(Effect.provide(testLayer()))
  );

  it.effect("drops entries that exceed maxAttempts", () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.Outbox;
      yield* outbox.enqueue(["a"], 1);

      yield* outbox.drain(() => Effect.fail("no"), { maxAttempts: 2 });
      yield* outbox.drain(() => Effect.fail("no"), { maxAttempts: 2 });

      const remaining = yield* outbox.size;

      expect(remaining).toBe(0);
    }).pipe(Effect.provide(testLayer()))
  );

  it.effect("discards entries without delivering them", () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.Outbox;
      const entry = yield* outbox.enqueue(["a"], 1);
      yield* outbox.discard(entry.id);
      const remaining = yield* outbox.size;

      expect(remaining).toBe(0);
    }).pipe(Effect.provide(testLayer()))
  );
});
