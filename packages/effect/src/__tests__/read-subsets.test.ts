/**
 * `SyncServer.readSubsets` (ADR-0025's read without its carrier, #163):
 * every subset of a batch is authorized before any backend call, so a
 * denied subset anywhere in the batch costs nothing; the rows of a subset
 * come back in the evaluated order whatever order `getRows` returns them.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
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

/** Every product, ordered by name. */
const byName = (direction: "asc" | "desc") =>
  Subset.make({ collection: "products", orderBy: [{ field: "name", direction }] });

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

  it.effect("evaluates a batch with one evaluateMany and fetches once per collection (#534)", () =>
    Effect.gen(function* () {
      const { backend: base } = yield* makeBackend;
      const counts = { evaluate: 0, evaluateMany: 0 };
      const fetchedFrom: Array<string> = [];
      const backend: Backend.Backend = {
        ...base,
        evaluate: (ctx, subset) => {
          counts.evaluate++;
          return base.evaluate(ctx, subset);
        },
        evaluateMany: (ctx, subsets) => {
          counts.evaluateMany++;
          return Effect.forEach(subsets, (subset) => base.evaluate(ctx, subset), {
            concurrency: 1,
          });
        },
        getRows: (ctx, collection, ids) => {
          fetchedFrom.push(collection);
          return base.getRows(ctx, collection, ids);
        },
      };
      const rows = yield* SyncServer.readSubsets(
        {
          backend,
          authPolicy: Authorization.policy({
            products: Authorization.allowAll,
            notes: Authorization.allowAll,
          }),
        },
        context,
        {
          clientGroupId: "g",
          subsets: [byName("asc"), Subset.make({ collection: "notes" }), byName("desc")],
        }
      );
      // Each subset's rows in its own evaluated order; a row two subsets share
      // comes back once for each.
      expect(rows.map((row) => row.id)).toEqual(["p-3", "p-1", "p-2", "p-2", "p-1", "p-3"]);
      expect(counts.evaluateMany).toBe(1);
      expect(counts.evaluate).toBe(0);
      expect(fetchedFrom.toSorted()).toEqual(["notes", "products"]);
    })
  );
});
