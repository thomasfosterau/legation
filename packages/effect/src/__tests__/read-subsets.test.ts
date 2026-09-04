/**
 * `SyncServer.readSubsets` (ADR-0025's read without its carrier, #163):
 * every subset of a batch is authorized before any backend call, so a
 * denied subset anywhere in the batch costs nothing; the rows of a subset
 * come back in the evaluated order whatever order `getRows` returns them.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { Authorization, type Backend, MemoryBackend, Mutator, Predicate } from "../index.js";
import { Subset, SyncServer } from "../internal.js";

const put = Mutator.make("row/put", Schema.Unknown);

const makeBackend = Effect.gen(function* () {
  const memory = yield* MemoryBackend.make({
    [put.name]: (args, writer) => {
      const row = args as { readonly collection: string; readonly id: string };
      return writer.put(row.collection, row.id, row);
    },
  });
  yield* memory.applyMutations(
    { clientGroupId: "seed" },
    [
      { collection: "products", id: "p-1", name: "Desk" },
      { collection: "products", id: "p-2", name: "Lamp" },
      { collection: "products", id: "p-3", name: "Chair" },
    ].map((row, index) => ({
      clientId: "seed",
      mutationId: index + 1,
      mutator: put.name,
      args: row,
      createdAt: 0,
    }))
  );
  let calls = 0;
  const backend: Backend.Backend = {
    ...memory,
    evaluate: (context, subset) => {
      calls++;
      return memory.evaluate(context, subset);
    },
    // A backend whose `getRows` promises nothing about order: reversed.
    getRows: (context, collection, ids) => {
      calls++;
      return memory.getRows(context, collection, ids).pipe(Effect.map((rows) => rows.toReversed()));
    },
  };
  return { backend, calls: () => calls };
});

const policy = Authorization.policy({ products: Authorization.allowAll });
const context = { clientGroupId: "g" };

describe("SyncServer.readSubsets", () => {
  it.effect(
    "authorizes every subset before any backend call: a denied later subset costs nothing",
    () =>
      Effect.gen(function* () {
        const { backend, calls } = yield* makeBackend;
        const exit = yield* Effect.exit(
          SyncServer.readSubsets({ backend, authPolicy: policy }, context, {
            clientGroupId: "g",
            subsets: [
              Subset.make({ collection: "products" }),
              Subset.make({ collection: "secrets" }), // no auth filter: denied by default
            ],
          })
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
        expect(failure?._tag === "Fail" && failure.error._tag).toBe("AuthorizationError");
        expect(calls()).toBe(0);
      })
  );

  it.effect("returns each subset's rows in the evaluated order, whatever getRows returns", () =>
    Effect.gen(function* () {
      const { backend, calls } = yield* makeBackend;
      const rows = yield* SyncServer.readSubsets({ backend, authPolicy: policy }, context, {
        clientGroupId: "g",
        subsets: [
          Subset.make({
            collection: "products",
            where: Predicate.ne("name", "Lamp"),
            orderBy: [{ field: "name", direction: "asc" }],
          }),
        ],
      });
      expect(rows.map((row) => row.id)).toEqual(["p-3", "p-1"]);
      expect(calls()).toBe(2);
    })
  );
});
