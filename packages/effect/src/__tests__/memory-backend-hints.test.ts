/**
 * MemoryBackend change hints across mutations (ADR-0023, #344): a push's hint
 * carries the current value of every row it PUT and omits every row it
 * deleted, whichever mutation of the push wrote last. A put in an earlier
 * mutation of the same push must not leave a value behind once a later
 * mutation deletes that row, or fine-grained fan-out would route a row that no
 * longer exists.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SyncContext } from "../Backend.js";
import * as MemoryBackend from "../MemoryBackend.js";
import type { Mutation } from "../Protocol.js";

const context: SyncContext = { clientGroupId: "memory-hints-group" };
const clientId = "memory-hints-client";
const rows = "rows";

const mutation = (mutationId: number, mutator: string, args: unknown): Mutation => ({
  clientId,
  mutationId,
  mutator,
  args,
  createdAt: 0,
});

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "test/put": (raw, writer) => {
    const { id, n } = raw as { readonly id: string; readonly n: number };
    return writer.put(rows, id, { n });
  },
  "test/del": (raw, writer) => {
    const { id } = raw as { readonly id: string };
    return writer.del(rows, id);
  },
};

describe("MemoryBackend change hints across mutations (#344)", () => {
  it.effect("a put then a later delete of the same row in one push carries no value", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);

      const result = yield* backend.applyMutations(context, [
        mutation(1, "test/put", { id: "r1", n: 1 }),
        mutation(2, "test/del", { id: "r1" }),
      ]);

      // r1 is touched (it was written, then deleted) but has no value: the
      // delete wins, so the hint must not carry the earlier put's value.
      expect(result.hints).toEqual([{ collection: rows, ids: ["r1"], values: [] }]);
      expect(yield* backend.getRows(context, rows, ["r1"])).toEqual([]);
    })
  );

  it.effect("a put then a later delete of a pre-existing row derives its old value only", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      yield* backend.applyMutations(context, [mutation(1, "test/put", { id: "r1", n: 1 })]);

      const result = yield* backend.applyMutations(context, [
        mutation(2, "test/put", { id: "r1", n: 2 }),
        mutation(3, "test/del", { id: "r1" }),
      ]);

      // ADR-0023: a delete derives topics from the row's old value, the value
      // it had before this push, not from the value a mutation of this push
      // wrote and then removed.
      expect(result.hints).toEqual([
        {
          collection: rows,
          ids: ["r1"],
          values: [],
          oldValues: [{ id: "r1", value: { n: 1 } }],
        },
      ]);
    })
  );

  it.effect("a delete then a later put of the same row in one push carries the new value", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(handlers);
      yield* backend.applyMutations(context, [mutation(1, "test/put", { id: "r1", n: 1 })]);

      const result = yield* backend.applyMutations(context, [
        mutation(2, "test/del", { id: "r1" }),
        mutation(3, "test/put", { id: "r1", n: 3 }),
      ]);

      // The row exists again at the end of the push, so its final value is hinted.
      expect(result.hints).toEqual([
        {
          collection: rows,
          ids: ["r1"],
          values: [{ id: "r1", value: { n: 3 } }],
          oldValues: [{ id: "r1", value: { n: 1 } }],
        },
      ]);
    })
  );

  it.effect("a put then delete within one mutation carries no value (unchanged)", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make({
        "test/put-del": (raw, writer) => {
          const { id, n } = raw as { readonly id: string; readonly n: number };
          return writer.put(rows, id, { n }).pipe(Effect.andThen(writer.del(rows, id)));
        },
      });

      const result = yield* backend.applyMutations(context, [
        mutation(1, "test/put-del", { id: "r1", n: 1 }),
      ]);

      expect(result.hints).toEqual([{ collection: rows, ids: ["r1"], values: [] }]);
    })
  );
});
