import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option } from "effect";
import type { CacheStore } from "../CacheStore.js";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Mutation from "../Mutation.js";
import * as SyncCache from "../SyncCache.js";

const testLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

const withCache = <A, E>(
  program: (cache: SyncCache.SyncCache) => Effect.Effect<A, E, SyncCache.SyncCache | CacheStore>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(SyncCache.SyncCache), program).pipe(
      Effect.provide(testLayer)
    ) as Effect.Effect<A, E>
  );

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

describe("Mutation", () => {
  it("executes a mutation and writes result updates into the cache", async () => {
    const descriptor = Mutation.make<Todo, Todo>({
      key: ["todos", "update"],
      execute: (todo) => Effect.succeed({ ...todo, title: `${todo.title}!` }),
      updates: (_input, result) => [{ key: ["todos", result.id], value: result }],
    });

    const result = await withCache((cache) =>
      Effect.gen(function* () {
        const output = yield* Mutation.execute(cache, descriptor, {
          id: "1",
          title: "write tests",
          done: false,
        });
        const cached = yield* cache.peek<Todo>(["todos", "1"]);
        return { output, cached: Option.getOrUndefined(cached)?.value };
      })
    );

    expect(result.output.title).toBe("write tests!");
    expect(result.cached?.title).toBe("write tests!");
  });

  it("applies optimistic patches and keeps them on success", async () => {
    const descriptor = Mutation.make<Todo, Todo>({
      key: ["todos", "update"],
      execute: (todo) => Effect.succeed(todo),
      optimistic: (todo) => [
        {
          key: ["todos", todo.id],
          update: () => ({ ...todo, optimistic: true }),
        },
      ],
    });

    const cached = await withCache((cache) =>
      Effect.gen(function* () {
        yield* Mutation.execute(cache, descriptor, { id: "1", title: "a", done: false });
        return yield* cache.peek(["todos", "1"]);
      })
    );

    expect(Option.isSome(cached)).toBe(true);
  });

  it("rolls back optimistic patches when the mutation fails", async () => {
    const descriptor = Mutation.make<Todo, Todo, string>({
      key: ["todos", "update"],
      execute: () => Effect.fail("server says no"),
      optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
    });

    const result = await withCache((cache) =>
      Effect.gen(function* () {
        // Seed a previous value.
        yield* cache.set(["todos", "1"], { id: "1", title: "original", done: false });

        const outcome = yield* Effect.result(
          Mutation.execute(cache, descriptor, { id: "1", title: "changed", done: true })
        );

        const cached = yield* cache.peek<Todo>(["todos", "1"]);
        return {
          failed: outcome._tag === "Failure",
          title: Option.getOrUndefined(cached)?.value.title,
        };
      })
    );

    expect(result.failed).toBe(true);
    expect(result.title).toBe("original");
  });

  it("removes optimistic entries on failure when the key was previously empty", async () => {
    const descriptor = Mutation.make<Todo, Todo, string>({
      key: ["todos", "create"],
      execute: () => Effect.fail("nope"),
      optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
    });

    const cached = await withCache((cache) =>
      Effect.gen(function* () {
        yield* Effect.result(
          Mutation.execute(cache, descriptor, { id: "new", title: "x", done: false })
        );
        return yield* cache.peek(["todos", "new"]);
      })
    );

    expect(Option.isNone(cached)).toBe(true);
  });

  it("invalidates dependent keys after success", async () => {
    const descriptor = Mutation.make<Todo, Todo>({
      key: ["todos", "create"],
      execute: (todo) => Effect.succeed(todo),
      invalidates: [["todos", "list"]],
    });

    const isStale = await withCache((cache) =>
      Effect.gen(function* () {
        // Populate a list entry that stays fresh for 5 minutes.
        yield* cache.set(["todos", "list"], ["1", "2"], { staleTime: Duration.minutes(5) });

        yield* Mutation.execute(cache, descriptor, { id: "3", title: "new", done: false });

        const entry = yield* cache.peek(["todos", "list"]);
        if (Option.isNone(entry)) return false;
        const now = Date.now();
        return entry.value.staleAt !== null && entry.value.staleAt <= now;
      })
    );

    expect(isStale).toBe(true);
  });
});
