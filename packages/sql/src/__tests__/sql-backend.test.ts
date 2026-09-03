/**
 * SqlBackend tests over an in-memory executor: evaluate compiles the right
 * WHERE and finalizes order/limit with Subset.apply; getRows fetches by id;
 * applyMutations runs handlers transactionally with an idempotent, gap-checked
 * mutation-id ledger.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { BackendError, MutationRejected, Mutator, Predicate } from "@legation/effect";
import { Subset } from "@legation/effect/internal";
import type { Backend } from "@legation/effect";
import * as Sql from "../Sql.js";
import * as SqlBackend from "../SqlBackend.js";

interface Mock {
  readonly executor: SqlBackend.SqlExecutor;
  readonly queries: ReadonlyArray<Sql.SqlFragment>;
  readonly seed: (table: string, rows: ReadonlyArray<SqlBackend.SqlRow>) => void;
}

/**
 * An executor that returns ledger rows for `sync_mutations` and seeded rows for
 * any other table (ignoring its WHERE — the backend re-applies the predicate
 * via Subset.apply). Records every query for SQL assertions.
 */
const makeMock = (): Mock => {
  const tables = new Map<string, ReadonlyArray<SqlBackend.SqlRow>>();
  const ledger = new Map<string, number>(); // `${group}:${client}` → lastId
  const queries: Array<Sql.SqlFragment> = [];

  const tableOf = (text: string): string | undefined => text.match(/FROM "([^"]+)"/)?.[1];

  const executor: SqlBackend.SqlExecutor = {
    query: (fragment) =>
      Effect.sync(() => {
        queries.push(fragment);
        if (fragment.text.includes(`"sync_mutations"`)) {
          const group = fragment.params[0];
          return [...ledger.entries()]
            .filter(([key]) => key.startsWith(`${group}:`))
            .map(([key, last]) => ({
              client_id: key.slice(String(group).length + 1),
              last_mutation_id: last,
            }));
        }
        const table = tableOf(fragment.text);
        return table !== undefined ? (tables.get(table) ?? []) : [];
      }),
    run: (fragment) =>
      Effect.sync(() => {
        if (fragment.text.includes(`"sync_mutations"`)) {
          const [group, client, last] = fragment.params as [string, string, number];
          ledger.set(`${group}:${client}`, last);
        }
      }),
    transaction: (effect) => effect,
  };

  return { executor, queries, seed: (table, rows) => tables.set(table, rows) };
};

const setTodo = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));
const tables = { todos: { table: "todos", versionColumn: "version" } };

describe("SqlBackend evaluate / getRows", () => {
  it.effect("compiles the WHERE and finalizes order + limit locally", () => {
    const mock = makeMock();
    mock.seed("todos", [
      { id: "1", status: "open", rank: 2, version: "a" },
      { id: "2", status: "open", rank: 1, version: "b" },
      { id: "3", status: "done", rank: 0, version: "c" },
    ]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables,
      mutators: new Map(),
      handlers: {},
    });
    const subset = Subset.make({
      collection: "todos",
      where: Predicate.eq("status", "open"),
      orderBy: [{ field: "rank", direction: "asc" }],
      limit: 1,
    });

    return Effect.gen(function* () {
      const entries = yield* backend.evaluate({ clientGroupId: "g" }, subset);
      // SQL pushed the predicate; Subset.apply ordered by rank + limited to 1.
      expect(entries).toEqual([{ id: "2", version: "b" }]);
      const select = mock.queries.at(-1)!;
      expect(select.text).toBe(`SELECT * FROM "todos" WHERE "status" COLLATE BINARY = ?`);
      expect(select.params).toEqual(["open"]);
    });
  });

  it.effect("passes the mapping's kinds to the compiler and decodes 0/1 booleans", () => {
    const mock = makeMock();
    // SQLite returns booleans as 0/1; `done` is declared boolean, `flags` is
    // not (and stays as the driver returned it, ADR-0014).
    mock.seed("todos", [
      { id: "1", done: 1, flags: 1, createdAt: "2020-02-29T12:34:56.789Z", version: "a" },
      { id: "2", done: 0, flags: 0, createdAt: "2024-01-01T00:00:00.000Z", version: "b" },
    ]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables: {
        todos: {
          table: "todos",
          versionColumn: "version",
          kinds: { done: "boolean", createdAt: "instant", status: "text" },
        },
      },
      mutators: new Map(),
      handlers: {},
    });
    const subset = Subset.make({
      collection: "todos",
      where: Predicate.and(
        Predicate.eq("done", false),
        Predicate.gt("createdAt", "2000-01-01T00:00:00.000Z")
      ),
    });

    return Effect.gen(function* () {
      const entries = yield* backend.evaluate({ clientGroupId: "g" }, subset);
      // The boolean literal was bound as 0, the instant got no collation
      // clause, and the decoded row (done: false) survived Subset.apply's
      // re-evaluation against the boolean literal.
      expect(entries).toEqual([{ id: "2", version: "b" }]);
      const select = mock.queries.at(-1)!;
      expect(select.text).toBe(`SELECT * FROM "todos" WHERE "done" = ? AND "createdAt" > ?`);
      expect(select.params).toEqual([0, "2000-01-01T00:00:00.000Z"]);

      const rows = yield* backend.getRows({ clientGroupId: "g" }, "todos", ["1"]);
      expect(rows[0]!.value).toEqual({
        id: "1",
        done: true,
        flags: 1,
        createdAt: "2020-02-29T12:34:56.789Z",
        version: "a",
      });
    });
  });

  it.effect("resolves a correlated Exists via a DISTINCT subquery", () => {
    const mock = makeMock();
    mock.seed("issues", [
      { id: "i1", projectId: "p1", version: "a" },
      { id: "i2", projectId: "p2", version: "b" },
      { id: "i3", projectId: "p1", version: "c" },
    ]);
    // The membership table returns alice's allowed project for the subquery.
    mock.seed("memberships", [{ projectId: "p1" }]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables: {
        issues: { table: "issues", versionColumn: "version" },
        memberships: { table: "memberships" },
      },
      mutators: new Map(),
      handlers: {},
    });
    const visible = Subset.make({
      collection: "issues",
      where: Predicate.exists({
        collection: "memberships",
        localField: "projectId",
        foreignField: "projectId",
        where: Predicate.eq("userId", "alice"),
      }),
    });

    return Effect.gen(function* () {
      const entries = yield* backend.evaluate({ clientGroupId: "g" }, visible);
      expect(entries.map((e) => e.id)).toEqual(["i1", "i3"]);
      // The correlated subquery was issued with the inner predicate's params.
      expect(mock.queries[0]).toEqual({
        text: `SELECT DISTINCT "projectId" FROM "memberships" WHERE "userId" COLLATE BINARY = ?`,
        params: ["alice"],
      });
    });
  });

  it.effect("fetches explicit rows by id", () => {
    const mock = makeMock();
    mock.seed("todos", [{ id: "1", version: "a", title: "x" }]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables,
      mutators: new Map(),
      handlers: {},
    });
    return Effect.gen(function* () {
      const rows = yield* backend.getRows({ clientGroupId: "g" }, "todos", ["1"]);
      expect(rows).toEqual([
        { id: "1", version: "a", value: { id: "1", version: "a", title: "x" } },
      ]);
      // Ids are strings, so the by-id lookup collates like any text `In`;
      // ADR-0028 §4 already requires the id column to be `COLLATE "C"` (the
      // order tie-break), so the clause costs no index use there.
      expect(mock.queries.at(-1)!.text).toBe(
        `SELECT * FROM "todos" WHERE "id" COLLATE BINARY IN (?)`
      );
    });
  });
});

describe("SqlBackend applyMutations", () => {
  const makeBackend = (mock: Mock, ran: Ref.Ref<number>) =>
    SqlBackend.make({
      executor: mock.executor,
      tables,
      mutators: new Map([[setTodo.name, setTodo]]),
      handlers: {
        "todo/set": () =>
          Ref.update(ran, (n) => n + 1).pipe(
            Effect.as<ReadonlyArray<Backend.ChangeHint>>([{ collection: "todos", ids: ["1"] }])
          ),
      },
    });

  const mutation = (mutationId: number) => ({
    clientId: "c1",
    mutationId,
    mutator: "todo/set",
    args: { id: "1" },
    createdAt: 0,
  });

  it.effect("applies in order, bumps the ledger, and skips replays", () => {
    const mock = makeMock();
    return Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      const backend = makeBackend(mock, ran);

      const first = yield* backend.applyMutations({ clientGroupId: "g" }, [mutation(1)]);
      expect(first.lastMutationIds).toEqual({ c1: 1 });
      // The hint carries the PUT's current row values (best-effort); the mock
      // executor stores nothing, so the enrichment read finds no row.
      expect(first.hints).toEqual([{ collection: "todos", ids: ["1"], values: [] }]);

      // Replaying id 1 is an idempotent no-op (handler does not run again).
      yield* backend.applyMutations({ clientGroupId: "g" }, [mutation(1)]);
      expect(yield* Ref.get(ran)).toBe(1);

      yield* backend.applyMutations({ clientGroupId: "g" }, [mutation(2)]);
      expect(yield* Ref.get(ran)).toBe(2);
    });
  });

  it.effect("enriches hints with the PUT's current row values", () => {
    const mock = makeMock();
    // A row the enrichment read finds for the hinted id.
    mock.seed("todos", [{ id: "1", version: "a", title: "x" }]);
    return Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      const backend = makeBackend(mock, ran);
      const result = yield* backend.applyMutations({ clientGroupId: "g" }, [mutation(1)]);
      // The hint carries the current row value for predicate-level fan-out.
      expect(result.hints).toEqual([
        {
          collection: "todos",
          ids: ["1"],
          values: [{ id: "1", value: { id: "1", version: "a", title: "x" } }],
        },
      ]);
    });
  });

  it.effect("rejects a mutation-id gap", () => {
    const mock = makeMock();
    return Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      const backend = makeBackend(mock, ran);
      const error = yield* backend
        .applyMutations({ clientGroupId: "g" }, [mutation(3)])
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(BackendError);
    });
  });

  it.effect(
    "rolls a permanently rejected mutation back to a savepoint but still bumps its id",
    () => {
      const mock = makeMock();
      // Record every statement so we can assert the savepoint dance.
      const runs: Array<string> = [];
      const executor: SqlBackend.SqlExecutor = {
        ...mock.executor,
        run: (fragment) => {
          runs.push(fragment.text);
          return mock.executor.run(fragment);
        },
      };
      const rejectTodo = Mutator.make("todo/reject", Schema.Struct({ id: Schema.String }));
      const backend = SqlBackend.make({
        executor,
        tables,
        mutators: new Map<string, Mutator.AnyMutator>([
          [setTodo.name, setTodo],
          [rejectTodo.name, rejectTodo],
        ]),
        handlers: {
          "todo/set": () =>
            Effect.succeed<ReadonlyArray<Backend.ChangeHint>>([
              { collection: "todos", ids: ["2"] },
            ]),
          // Write, then reject permanently.
          "todo/reject": (_args, tx) =>
            tx
              .run({ text: `INSERT INTO "todos" VALUES (?)`, params: ["poison"] })
              .pipe(Effect.andThen(Effect.fail(new MutationRejected({ reason: "forbidden" })))),
        },
      });
      const at = (id: number, mutator: string, args: unknown) => ({
        clientId: "c1",
        mutationId: id,
        mutator,
        args,
        createdAt: 0,
      });

      return Effect.gen(function* () {
        const result = yield* backend.applyMutations({ clientGroupId: "g" }, [
          at(1, "todo/reject", { id: "poison" }),
          at(2, "todo/set", { id: "2" }),
        ]);
        // The rejected mutation and the one behind it are both acknowledged.
        expect(result.lastMutationIds).toEqual({ c1: 2 });
        expect(result.rejected).toEqual([{ clientId: "c1", mutationId: 1, reason: "forbidden" }]);
        // Only the applied mutation contributes a hint (values enriched
        // best-effort; the mock executor stores no row to read back).
        expect(result.hints).toEqual([{ collection: "todos", ids: ["2"], values: [] }]);
        // The rejection rolled its write back to a savepoint.
        expect(runs.some((text) => text.startsWith("SAVEPOINT "))).toBe(true);
        expect(runs.some((text) => text.startsWith("ROLLBACK TO SAVEPOINT "))).toBe(true);
      });
    }
  );
});
