import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Mutation from "../Mutation.js";
import * as SyncCache from "../SyncCache.js";

const testLayer = () => SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

describe("Mutation", () => {
  it.effect("executes a mutation and writes result updates into the cache", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Mutation.make<Todo, Todo>({
        key: ["todos", "update"],
        execute: (todo) => Effect.succeed({ ...todo, title: `${todo.title}!` }),
        updates: (_input, result) => [{ key: ["todos", result.id], value: result }],
      });

      const output = yield* Mutation.execute(cache, descriptor, {
        id: "1",
        title: "write tests",
        done: false,
      });
      const cached = yield* cache.peek<Todo>(["todos", "1"]);

      expect(output.title).toBe("write tests!");
      expect(Option.getOrUndefined(cached)?.value.title).toBe("write tests!");
    }).pipe(Effect.provide(testLayer())));

  it.effect("applies optimistic patches and keeps them on success", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
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

      yield* Mutation.execute(cache, descriptor, { id: "1", title: "a", done: false });
      const cached = yield* cache.peek(["todos", "1"]);

      expect(Option.isSome(cached)).toBe(true);
    }).pipe(Effect.provide(testLayer())));

  it.effect("rolls back optimistic patches when the mutation fails", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Mutation.make<Todo, Todo, string>({
        key: ["todos", "update"],
        execute: () => Effect.fail("server says no"),
        optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
      });

      // Seed a previous value.
      yield* cache.set(["todos", "1"], { id: "1", title: "original", done: false });

      const outcome = yield* Effect.result(
        Mutation.execute(cache, descriptor, { id: "1", title: "changed", done: true })
      );

      const cached = yield* cache.peek<Todo>(["todos", "1"]);

      expect(outcome._tag === "Failure").toBe(true);
      expect(Option.getOrUndefined(cached)?.value.title).toBe("original");
    }).pipe(Effect.provide(testLayer())));

  it.effect("removes optimistic entries on failure when the key was previously empty", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Mutation.make<Todo, Todo, string>({
        key: ["todos", "create"],
        execute: () => Effect.fail("nope"),
        optimistic: (todo) => [{ key: ["todos", todo.id], update: () => todo }],
      });

      yield* Effect.result(
        Mutation.execute(cache, descriptor, { id: "new", title: "x", done: false })
      );
      const cached = yield* cache.peek(["todos", "new"]);

      expect(Option.isNone(cached)).toBe(true);
    }).pipe(Effect.provide(testLayer())));

  it.effect("invalidates dependent keys after success", () =>
    Effect.gen(function* () {
      const cache = yield* SyncCache.SyncCache;
      const descriptor = Mutation.make<Todo, Todo>({
        key: ["todos", "create"],
        execute: (todo) => Effect.succeed(todo),
        invalidates: [["todos", "list"]],
      });

      // Populate a list entry that stays fresh for 5 minutes.
      yield* cache.set(["todos", "list"], ["1", "2"], { staleTime: Duration.minutes(5) });

      yield* Mutation.execute(cache, descriptor, { id: "3", title: "new", done: false });

      const entry = yield* cache.peek(["todos", "list"]);
      const now = Date.now();
      const isStale =
        Option.isSome(entry) && entry.value.staleAt !== null && entry.value.staleAt <= now;

      expect(isStale).toBe(true);
    }).pipe(Effect.provide(testLayer())));
});
