import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { CacheStore } from "../CacheStore.js";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Outbox from "../Outbox.js";

const withOutbox = <A, E>(
  program: (outbox: Outbox.Outbox) => Effect.Effect<A, E, Outbox.Outbox | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(Outbox.Outbox), program).pipe(
      Effect.provide(Outbox.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer())))
    ) as Effect.Effect<A, E>
  );

describe("Outbox", () => {
  it("enqueues entries and lists them oldest first", async () => {
    const entries = await withOutbox((outbox) =>
      Effect.gen(function* () {
        yield* outbox.enqueue(["todos", "create"], { title: "first" });
        yield* outbox.enqueue(["todos", "create"], { title: "second" });
        return yield* outbox.entries;
      })
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => (entry.input as { title: string }).title)).toEqual([
      "first",
      "second",
    ]);
  });

  it("drains entries, removing delivered ones", async () => {
    const result = await withOutbox((outbox) =>
      Effect.gen(function* () {
        yield* outbox.enqueue(["a"], 1);
        yield* outbox.enqueue(["b"], 2);

        const drain = yield* outbox.drain(() => Effect.succeed("ok"));
        const remaining = yield* outbox.size;

        return { drain, remaining };
      })
    );

    expect(result.drain.completed).toBe(2);
    expect(result.drain.failed).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("keeps failed entries for the next drain", async () => {
    const result = await withOutbox((outbox) =>
      Effect.gen(function* () {
        yield* outbox.enqueue(["a"], 1);

        const drain = yield* outbox.drain(() => Effect.fail("delivery failed"));
        const entries = yield* outbox.entries;

        return { drain, entries };
      })
    );

    expect(result.drain.failed).toBe(1);
    expect(result.drain.remaining).toBe(1);
    expect(result.entries[0]?.status).toBe("failed");
    expect(result.entries[0]?.attempts).toBe(1);
  });

  it("drops entries that exceed maxAttempts", async () => {
    const remaining = await withOutbox((outbox) =>
      Effect.gen(function* () {
        yield* outbox.enqueue(["a"], 1);

        yield* outbox.drain(() => Effect.fail("no"), { maxAttempts: 2 });
        yield* outbox.drain(() => Effect.fail("no"), { maxAttempts: 2 });

        return yield* outbox.size;
      })
    );

    expect(remaining).toBe(0);
  });

  it("discards entries without delivering them", async () => {
    const remaining = await withOutbox((outbox) =>
      Effect.gen(function* () {
        const entry = yield* outbox.enqueue(["a"], 1);
        yield* outbox.discard(entry.id);
        return yield* outbox.size;
      })
    );

    expect(remaining).toBe(0);
  });
});
