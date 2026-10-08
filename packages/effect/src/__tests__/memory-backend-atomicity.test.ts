/**
 * MemoryBackend atomicity (Backend guarantee 1, issue #341): a mutation's
 * writes become visible only together with its lastMutationId bump, a
 * `BackendError` discards its writes, and a handler reads back its own staged
 * writes.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import type { SyncContext } from "../Backend.js";
import { BackendError, MutationRejected } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";

const context: SyncContext = { clientGroupId: "memory-atomicity-group" };
const clientId = "memory-atomicity-client";
const rows = "rows";

const mutation = (mutationId: number, mutator: string, args: unknown): Mutation => ({
  clientId,
  mutationId,
  mutator,
  args,
  createdAt: 0,
});

interface Args {
  readonly id: string;
  readonly n: number;
}

const argsOf = (raw: unknown): Args => raw as Args;

/** Plain sets, plus the failure and parking shapes each test needs. */
const handlersFor = (hooks: {
  readonly written: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly observed: Ref.Ref<ReadonlyArray<unknown>>;
}): Record<string, MemoryBackend.BackendHandler> => ({
  "test/set": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer.put(rows, id, { n });
  },
  // Write, then park before returning: the window a pull or evaluate can hit.
  "test/park": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(
        Effect.andThen(Deferred.succeed(hooks.written, undefined)),
        Effect.andThen(Deferred.await(hooks.release))
      );
  },
  // Write, park, then reject permanently.
  "test/park-reject": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(
        Effect.andThen(Deferred.succeed(hooks.written, undefined)),
        Effect.andThen(Deferred.await(hooks.release)),
        Effect.andThen(Effect.fail(new MutationRejected({ reason: "parked and rejected" })))
      );
  },
  // Write, then fail transiently.
  "test/fail-after-write": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(Effect.andThen(Effect.fail(new BackendError({ message: "transient after write" }))));
  },
  // Write, read it back, delete it, read again.
  "test/read-back": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return Effect.gen(function* () {
      yield* writer.put(rows, id, { n });
      const afterPut = yield* writer.get(rows, id);
      yield* writer.del(rows, id);
      const afterDel = yield* writer.get(rows, id);
      yield* Ref.set(hooks.observed, [afterPut, afterDel]);
    });
  },
});

const makeHooks = Effect.gen(function* () {
  return {
    written: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    observed: yield* Ref.make<ReadonlyArray<unknown>>([]),
  };
});

describe("MemoryBackend atomicity", () => {
  it.effect("keeps a handler's writes and its bump invisible until the mutation commits", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      const push = yield* Effect.forkChild(
        backend.applyMutations(context, [mutation(1, "test/park", { id: "a", n: 1 })])
      );
      // The handler has written and is parked before it returns.
      yield* Deferred.await(hooks.written);

      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.evaluate(context, Subset.make({ collection: rows }))).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({});

      yield* Deferred.succeed(hooks.release, undefined);
      const result = yield* Fiber.join(push);

      // After the mutation finishes, the write and the bump are both visible.
      expect(result.lastMutationIds[clientId]).toBe(1);
      const [row] = yield* backend.getRows(context, rows, ["a"]);
      expect(row?.value).toEqual({ n: 1 });
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("discards a rejected mutation's writes and bumps only after it parks", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      const push = yield* Effect.forkChild(
        backend.applyMutations(context, [mutation(1, "test/park-reject", { id: "a", n: 1 })])
      );
      yield* Deferred.await(hooks.written);

      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({});

      yield* Deferred.succeed(hooks.release, undefined);
      const result = yield* Fiber.join(push);

      expect(result.lastMutationIds[clientId]).toBe(1);
      expect(result.rejected?.map((entry) => entry.mutationId)).toEqual([1]);
      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("leaves a row unchanged and bumps nothing when a handler fails after a write", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      yield* backend.applyMutations(context, [mutation(1, "test/set", { id: "a", n: 1 })]);
      const [before] = yield* backend.getRows(context, rows, ["a"]);

      const exit = yield* Effect.exit(
        backend.applyMutations(context, [mutation(2, "test/fail-after-write", { id: "a", n: 2 })])
      );
      expect(exit._tag).toBe("Failure");

      // The failed write is gone: same value, same version, no bump.
      const [after] = yield* backend.getRows(context, rows, ["a"]);
      expect(after).toEqual(before);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });

      // The client's retry of mutation 2 then applies and bumps, with a newer version.
      const retry = yield* backend.applyMutations(context, [
        mutation(2, "test/set", { id: "a", n: 2 }),
      ]);
      expect(retry.lastMutationIds[clientId]).toBe(2);
      const [retried] = yield* backend.getRows(context, rows, ["a"]);
      expect(retried?.value).toEqual({ n: 2 });
      expect(Number(retried?.version)).toBeGreaterThan(Number(before?.version));
    })
  );

  it.effect("lets a handler read back its own staged writes and deletes", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      yield* backend.applyMutations(context, [mutation(1, "test/read-back", { id: "a", n: 7 })]);

      expect(yield* Ref.get(hooks.observed)).toEqual([{ n: 7 }, undefined]);
      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );
});
