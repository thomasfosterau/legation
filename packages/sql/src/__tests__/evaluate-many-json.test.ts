/**
 * `SqlBackend.evaluateMany` on a `Json` dialect (PostgreSQL's `row_to_json`)
 * over a fake executor with canned rows (#505). A row whose JSON holds a
 * number `JSON.parse` cannot carry exactly (a `numeric` past a double's
 * digits, an integer past ±(2^53 − 1), such a number nested in a `jsonb`
 * column) sends the pull to `evaluate` per subset, and the backend warns once
 * per collection and column with an `InexactJsonNumber`. A real PostgreSQL
 * run of the wide-integer case is in `pg-executor.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import { Mutator } from "@thomasfosterau/legation-effect";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as Sql from "../Sql.js";
import * as SqlBackend from "../SqlBackend.js";

const context = { clientGroupId: "g" };

/** A batched statement's rows: subset 0's row as JSON text, as `row_to_json(…)::text` gives it. */
const jsonRows = (rows: ReadonlyArray<string>): ReadonlyArray<SqlBackend.SqlRow> =>
  rows.map((row) => ({ subset: 0, row }));

/**
 * A backend over a fake executor: the batched `UNION ALL` statement answers
 * with `batched`, any other statement (one `evaluate`) with `driver`, the
 * rows the driver would give. Counts statements.
 */
const makeBackend = (
  batched: ReadonlyArray<string>,
  driver: ReadonlyArray<SqlBackend.SqlRow>,
  statements: Ref.Ref<number>
) =>
  SqlBackend.make({
    executor: {
      query: (fragment) =>
        Ref.update(statements, (n) => n + 1).pipe(
          Effect.as(fragment.text.includes("row_to_json") ? jsonRows(batched) : driver)
        ),
      run: () => Effect.void,
      transaction: (effect) => effect,
    },
    dialect: Sql.postgres,
    tables: { items: { table: "items", versionColumn: "version" } },
    mutators: Mutator.registry([]).mutators,
    handlers: {},
  });

/** The warnings logged while running `effect`, with the `InexactJsonNumber` each carried. */
const withWarnings = <A, E>(
  use: (warnings: ReadonlyArray<SqlBackend.InexactJsonNumber>) => Effect.Effect<A, E>
) => {
  const warnings: Array<SqlBackend.InexactJsonNumber> = [];
  const collector = Logger.make((options) => {
    if (options.logLevel !== "Warn") return;
    const parts: ReadonlyArray<unknown> = Array.isArray(options.message)
      ? options.message
      : [options.message];
    warnings.push(...parts.filter((part) => part instanceof SqlBackend.InexactJsonNumber));
  });
  return use(warnings).pipe(Effect.withLogger(collector));
};

const pull = [Subset.make({ collection: "items" })];

describe("SqlBackend.evaluateMany on a Json dialect (#505)", () => {
  it.effect("reads exact JSON numbers from the one statement, without a warning", () =>
    withWarnings((warnings) =>
      Effect.gen(function* () {
        const statements = yield* Ref.make(0);
        // A double at its shortest form and a numeric with a trailing zero
        // both read back as the value they spell.
        const backend = makeBackend(
          [
            `{"id":"a","version":1,"amount":0.30000000000000004}`,
            `{"id":"b","version":9007199254740991,"amount":1.50,"meta":{"n":-2.5e-7}}`,
          ],
          [],
          statements
        );
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        expect(yield* evaluateMany(context, pull)).toEqual([
          [
            { id: "a", version: 1 },
            { id: "b", version: 9007199254740991 },
          ],
        ]);
        expect(yield* Ref.get(statements)).toBe(1);
        expect(warnings).toEqual([]);
      })
    )
  );

  it.effect("falls back to evaluate for a numeric past a double, and warns once per column", () =>
    withWarnings((warnings) =>
      Effect.gen(function* () {
        const statements = yield* Ref.make(0);
        const backend = makeBackend(
          [`{"id":"a","version":1,"amount":0.1000000000000000000001}`],
          [{ id: "a", version: 1, amount: "0.1000000000000000000001" }],
          statements
        );
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        const single = yield* backend.evaluate(
          context,
          pull[0] ?? Subset.make({ collection: "items" })
        );
        yield* Ref.set(statements, 0);
        expect(yield* evaluateMany(context, pull)).toEqual([single]);
        // The batched statement, then one evaluate.
        expect(yield* Ref.get(statements)).toBe(2);
        expect(yield* evaluateMany(context, pull)).toEqual([single]);
        expect(yield* Ref.get(statements)).toBe(4);
        expect(warnings.map(({ collection, column }) => ({ collection, column }))).toEqual([
          { collection: "items", column: "amount" },
        ]);
        // The warning names the column, never the value.
        expect(warnings[0]?.message).not.toContain("0.1000000000000000000001");
      })
    )
  );

  it.effect("falls back for an integer past 2^53, nested in a jsonb column too", () =>
    withWarnings((warnings) =>
      Effect.gen(function* () {
        const statements = yield* Ref.make(0);
        const backend = makeBackend(
          [
            `{"id":"a","version":9007199254740993}`,
            `{"id":"b","version":2,"meta":{"tags":["x"],"n":[9007199254740994]}}`,
          ],
          [
            { id: "a", version: "9007199254740993" },
            { id: "b", version: 2, meta: { tags: ["x"], n: [9007199254740994] } },
          ],
          statements
        );
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        expect(yield* evaluateMany(context, pull)).toEqual([
          [
            { id: "a", version: "9007199254740993" },
            { id: "b", version: 2 },
          ],
        ]);
        expect(warnings.map(({ column }) => column)).toEqual(["version", "meta"]);
      })
    )
  );
});

describe("SqlBackend.evaluateMany names every inexact column (#505)", () => {
  it.effect("warns for each inexact column of a row, its JSON escapes decoded", () =>
    withWarnings((warnings) =>
      Effect.gen(function* () {
        const statements = yield* Ref.make(0);
        const backend = makeBackend(
          [`{"id":"a","version":9007199254740993,"net\\"amount":0.1000000000000000000001}`],
          [{ id: "a", version: "9007199254740993", 'net"amount': "0.1000000000000000000001" }],
          statements
        );
        const evaluateMany = backend.evaluateMany;
        if (evaluateMany === undefined) return expect.unreachable("evaluateMany is defined");
        expect(yield* evaluateMany(context, pull)).toEqual([
          [{ id: "a", version: "9007199254740993" }],
        ]);
        expect(warnings.map(({ column }) => column)).toEqual(["version", 'net"amount']);
      })
    )
  );
});
