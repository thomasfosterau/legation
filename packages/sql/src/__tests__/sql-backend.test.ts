/**
 * SqlBackend tests over an in-memory executor: evaluate compiles the right
 * WHERE and finalizes order/limit with Subset.apply; getRows fetches by id;
 * applyMutations runs handlers transactionally with an idempotent, gap-checked
 * mutation-id ledger.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import {
  Authorization,
  BackendError,
  Collection,
  MutationRejected,
  Mutator,
  Predicate,
  Server,
} from "@thomasfosterau/legation-effect";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import type { Backend } from "@thomasfosterau/legation-effect";
import * as Sql from "../Sql.js";
import * as SqlBackend from "../SqlBackend.js";

interface Mock {
  readonly executor: SqlBackend.SqlExecutor;
  readonly queries: ReadonlyArray<Sql.SqlFragment>;
  readonly seed: (table: string, rows: ReadonlyArray<SqlBackend.SqlRow>) => void;
  /** The ledger's watermark for a client (0 when it has no row). */
  readonly ledgerOf: (clientGroupId: string, clientId: string) => number;
}

const tableOf = (text: string): string | undefined => text.match(/FROM "([^"]+)"/)?.[1];
const isLedger = (text: string): boolean => text.includes(`"sync_mutations"`);
// The bump after a handler on an executor without transactions: an upsert to
// the larger of the stored and the new id (SqlBackend's `dialect.greatest`).
const MONOTONIC_BUMP =
  /DO UPDATE SET "last_mutation_id" = MAX\("sync_mutations"\."last_mutation_id", excluded\."last_mutation_id"\)$/;
const unmodelled = (fragment: Sql.SqlFragment): never => {
  throw new Error(`mock ledger: unmodelled statement: ${fragment.text}`);
};

/**
 * An executor that returns ledger rows for `sync_mutations` and seeded rows for
 * any other table (ignoring its WHERE — the backend re-applies the predicate
 * via Subset.apply). Records every query for SQL assertions.
 *
 * The ledger models exactly the statements `SqlBackend` issues for one ordering
 * and throws on any other ledger SQL, so a regression to an unmodelled
 * statement (say, an unconditional bump after the handler on the claim-first
 * path) fails the tests instead of passing silently:
 * - `transactional` (the default; its transaction does not serialise): the
 *   reads, insert-if-absent at 0, the conditional claim (`UPDATE ... RETURNING`)
 *   and the claim's release (a conditional `UPDATE`).
 * - `transactional: false` (D1's order): the reads and the bump after the
 *   handler, an upsert to the larger of the stored and the new id.
 */
const makeMock = (options: { readonly transactional?: boolean } = {}): Mock => {
  const transactional = options.transactional ?? true;
  const tables = new Map<string, ReadonlyArray<SqlBackend.SqlRow>>();
  const ledger = new Map<string, number>(); // `${group}:${client}` → lastId
  const queries: Array<Sql.SqlFragment> = [];

  // The claim and its release: `UPDATE "sync_mutations"` with params
  // `[next, group, client, expected]`, moving the row only when it reads
  // `expected`, as the database's conditional UPDATE does.
  const casLedger = (fragment: Sql.SqlFragment): boolean => {
    const [next, group, client, expected] = fragment.params as [number, string, string, number];
    const key = `${group}:${client}`;
    if (ledger.get(key) !== expected) return false;
    ledger.set(key, next);
    return true;
  };

  // The ledger writes each ordering issues, matched by statement text.
  const insertIfAbsent = (fragment: Sql.SqlFragment): void => {
    // `ON CONFLICT DO NOTHING` at 0.
    const [group, client] = fragment.params as [string, string];
    const key = `${group}:${client}`;
    if (!ledger.has(key)) ledger.set(key, 0);
  };
  const giveBackClaim = (fragment: Sql.SqlFragment): void => {
    // The release of a claim: a conditional UPDATE.
    casLedger(fragment);
  };
  const bumpMonotonic = (fragment: Sql.SqlFragment): void => {
    // The bump after the handler: the watermark only rises.
    const [group, client, id] = fragment.params as [string, string, number];
    const key = `${group}:${client}`;
    ledger.set(key, Math.max(ledger.get(key) ?? 0, id));
  };
  const ledgerWrites: ReadonlyArray<readonly [RegExp, (fragment: Sql.SqlFragment) => void]> =
    transactional
      ? [
          [/DO NOTHING$/, insertIfAbsent],
          [/^UPDATE "sync_mutations"/, giveBackClaim],
        ]
      : [[MONOTONIC_BUMP, bumpMonotonic]];

  const executor: SqlBackend.SqlExecutor = {
    query: (fragment) =>
      Effect.sync(() => {
        queries.push(fragment);
        if (isLedger(fragment.text)) {
          if (transactional && /^UPDATE "sync_mutations" .* RETURNING /.test(fragment.text)) {
            return casLedger(fragment) ? [{ last_mutation_id: fragment.params[0] }] : [];
          }
          if (/^SELECT .* FROM "sync_mutations" WHERE /.test(fragment.text)) {
            const group = fragment.params[0];
            return [...ledger.entries()]
              .filter(([key]) => key.startsWith(`${group}:`))
              .map(([key, last]) => ({
                client_id: key.slice(String(group).length + 1),
                last_mutation_id: last,
              }));
          }
          return unmodelled(fragment);
        }
        const table = tableOf(fragment.text);
        return table !== undefined ? (tables.get(table) ?? []) : [];
      }),
    run: (fragment) =>
      Effect.sync(() => {
        if (!isLedger(fragment.text)) return;
        const statement = ledgerWrites.find(([pattern]) => pattern.test(fragment.text));
        if (statement === undefined) return unmodelled(fragment);
        statement[1](fragment);
      }),
    transaction: (effect) => effect,
    transactional,
  };

  return {
    executor,
    queries,
    seed: (table, rows) => tables.set(table, rows),
    ledgerOf: (group, client) => ledger.get(`${group}:${client}`) ?? 0,
  };
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
      // No kinds are declared, so nothing collates.
      expect(select.text).toBe(`SELECT * FROM "todos" WHERE "status" = ?`);
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
        text: `SELECT DISTINCT "projectId" FROM "memberships" WHERE "userId" = ?`,
        params: ["alice"],
      });
    });
  });

  it.effect("resolves Exists like MemoryBackend: NULL foreign values out, kinds decoded", () => {
    const mock = makeMock();
    mock.seed("issues", [
      { id: "i1", projectId: "p1", flagged: 1, version: "a" },
      { id: "i2", projectId: "p2", flagged: 0, version: "b" },
    ]);
    // A membership row without a project (NULL) and one flagged as active
    // (SQLite's 1 for a boolean column).
    mock.seed("memberships", [{ projectId: null }, { projectId: "p1" }, { active: 1 }]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables: {
        issues: { table: "issues", versionColumn: "version", kinds: { flagged: "boolean" } },
        memberships: { table: "memberships", kinds: { userId: "text", active: "boolean" } },
      },
      mutators: new Map(),
      handlers: {},
    });
    const membership = (where: Predicate.Predicate) =>
      Predicate.exists({
        collection: "memberships",
        localField: "projectId",
        foreignField: "projectId",
        where,
      });

    return Effect.gen(function* () {
      // NULL equals nothing: `Not(Exists)` keeps i2 (as `Predicate.existsValues`
      // does for MemoryBackend) instead of going unknown on the NULL.
      const hidden = yield* backend.evaluate(
        { clientGroupId: "g" },
        Subset.make({ collection: "issues", where: Predicate.not(membership(Predicate.always)) })
      );
      expect(hidden.map((e) => e.id)).toEqual(["i2"]);
      // The subquery took the foreign table's kinds: its text field collates.
      const subquery = mock.queries.find((q) => q.text.startsWith("SELECT DISTINCT"))!;
      expect(subquery.text).toBe(`SELECT DISTINCT "projectId" FROM "memberships" WHERE 1 = 1`);
      const named = yield* backend.evaluate(
        { clientGroupId: "g" },
        Subset.make({ collection: "issues", where: membership(Predicate.eq("userId", "alice")) })
      );
      expect(named.map((e) => e.id)).toEqual(["i1"]);
      expect(mock.queries.at(-2)!.text).toBe(
        `SELECT DISTINCT "projectId" FROM "memberships" WHERE "userId" COLLATE BINARY = ?`
      );
      // A boolean foreign field yields true/false, not 1/0, so the resolved
      // `In` matches the decoded local column.
      const flagged = yield* backend.evaluate(
        { clientGroupId: "g" },
        Subset.make({
          collection: "issues",
          where: Predicate.exists({
            collection: "memberships",
            localField: "flagged",
            foreignField: "active",
            where: Predicate.always,
          }),
        })
      );
      expect(flagged.map((e) => e.id)).toEqual(["i1"]);
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
      // The id column has no declared kind (it may well be a uuid or serial
      // on Postgres), so the by-id lookup is a plain `IN`.
      expect(mock.queries.at(-1)!.text).toBe(`SELECT * FROM "todos" WHERE "id" IN (?)`);
    });
  });
});

// Trunk's behaviour, under both orderings: claim-first (transactions) and
// handler-then-bump (no transactions, D1). The claim-specific READ COMMITTED
// tests below stay on the transactional ordering.
describe.each([true, false])("SqlBackend applyMutations (transactional: %s)", (transactional) => {
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
    const mock = makeMock({ transactional });
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
      expect(yield* backend.lastMutationIds({ clientGroupId: "g" })).toEqual({ c1: 2 });
    });
  });

  it.effect("enriches hints with the PUT's current row values", () => {
    const mock = makeMock({ transactional });
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
    const mock = makeMock({ transactional });
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
    "rolls a permanently rejected mutation back to a savepoint but still takes its id",
    () => {
      const mock = makeMock({ transactional });
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

describe("TableMapping.fromCollection (issue #204)", () => {
  it.effect("derives kinds from the collection's declared filterable set", () => {
    const todosCollection = Collection.make({
      name: "todos",
      schema: Schema.Unknown,
      id: (value) => (value as { id: string }).id,
      filterable: { done: { kind: "boolean", operators: ["eq"] } },
    });
    const mapping = SqlBackend.fromCollection(todosCollection, {
      table: "todos",
      versionColumn: "version",
    });
    // "id" is present from the key defaults every collection carries
    // (Collection.filterDeclarationOf), with no column list written by hand.
    expect(mapping).toEqual({
      table: "todos",
      versionColumn: "version",
      kinds: { id: "text", done: "boolean" },
    });

    const mock = makeMock();
    mock.seed("todos", [
      { id: "1", done: 1, version: "a" },
      { id: "2", done: 0, version: "b" },
    ]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables: { todos: mapping },
      mutators: new Map(),
      handlers: {},
    });
    return Effect.gen(function* () {
      // The derived kinds drive the compiler exactly like a hand-written
      // mapping's: the boolean literal binds per dialect (0) and SQLite's
      // 0/1 decodes back to a boolean on the way out.
      const entries = yield* backend.evaluate(
        { clientGroupId: "g" },
        Subset.make({ collection: "todos", where: Predicate.eq("done", false) })
      );
      expect(entries).toEqual([{ id: "2", version: "b" }]);
      expect(mock.queries.at(-1)!.text).toBe(`SELECT * FROM "todos" WHERE "done" = ?`);
      expect(mock.queries.at(-1)!.params).toEqual([0]);
    });
  });
});

describe("TableMapping.readRelation (issue #204)", () => {
  it.effect("evaluate and getRows read the relation, not the write target", () => {
    const mock = makeMock();
    // Only "todos_view" is seeded: a query against "todos" would find nothing.
    mock.seed("todos_view", [{ id: "1", version: "a" }]);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables: {
        todos: { table: "todos", readRelation: "todos_view", versionColumn: "version" },
      },
      mutators: new Map(),
      handlers: {},
    });
    return Effect.gen(function* () {
      const entries = yield* backend.evaluate(
        { clientGroupId: "g" },
        Subset.make({ collection: "todos" })
      );
      expect(entries).toEqual([{ id: "1", version: "a" }]);
      expect(mock.queries.at(-1)!.text).toBe(`SELECT * FROM "todos_view" WHERE 1 = 1`);

      const rows = yield* backend.getRows({ clientGroupId: "g" }, "todos", ["1"]);
      expect(rows).toEqual([{ id: "1", version: "a", value: { id: "1", version: "a" } }]);
      expect(mock.queries.at(-1)!.text).toBe(`SELECT * FROM "todos_view" WHERE "id" IN (?)`);
    });
  });
});

describe("tombstones and fail-closed relations across a pull (issue #204)", () => {
  const allowTodos = Authorization.policy({ todos: Authorization.allowAll });
  const allTodos = [Subset.make({ collection: "todos" })];

  it.effect("a row matching the tombstone predicate patches as a delete, not a put", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMock();
        mock.seed("todos", [{ id: "1", version: "a", deletedAt: null }]);
        const backend = SqlBackend.make({
          executor: mock.executor,
          tables: {
            todos: {
              table: "todos",
              versionColumn: "version",
              // The engine's own predicate vocabulary, not a bespoke shape.
              tombstone: Predicate.isNotNull("deletedAt"),
            },
          },
          mutators: new Map(),
          handlers: {},
        });
        const server = yield* Server.make({ backend, auth: { policy: allowTodos } });

        const first = yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: allTodos,
        });
        expect(first.patch).toEqual([
          {
            _tag: "Put",
            collection: "todos",
            id: "1",
            version: "a",
            value: { id: "1", version: "a", deletedAt: null },
          },
        ]);

        // Soft-deleted in place: the row still exists in "todos", but now
        // matches the tombstone predicate.
        mock.seed("todos", [{ id: "1", version: "b", deletedAt: "2024-01-01T00:00:00.000Z" }]);
        const second = yield* server.handler.handlePull({
          clientGroupId: "g",
          cookie: first.cookie,
          subscriptions: allTodos,
        });
        expect(second.patch).toEqual([{ _tag: "Del", collection: "todos", id: "1" }]);
      })
    )
  );

  it.effect("a row that vanishes from the relation entirely also patches as a delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMock();
        mock.seed("todos", [
          { id: "1", version: "a" },
          { id: "2", version: "b" },
        ]);
        const backend = SqlBackend.make({
          executor: mock.executor,
          tables: { todos: { table: "todos", versionColumn: "version" } },
          mutators: new Map(),
          handlers: {},
        });
        const server = yield* Server.make({ backend, auth: { policy: allowTodos } });

        const first = yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: allTodos,
        });
        expect(first.patch).toEqual([
          {
            _tag: "Put",
            collection: "todos",
            id: "1",
            version: "a",
            value: { id: "1", version: "a" },
          },
          {
            _tag: "Put",
            collection: "todos",
            id: "2",
            version: "b",
            value: { id: "2", version: "b" },
          },
        ]);

        // "2" is hard-deleted from the relation with no tombstone marker at
        // all — no workaround, no auth-filter trick, just gone. This is the
        // fail-closed property the whole model rests on: `evaluate` is "the
        // set of (id, version) the relation currently returns", so a row
        // outside that set diffs as a delete exactly like a tombstoned one.
        mock.seed("todos", [{ id: "1", version: "a" }]);
        const second = yield* server.handler.handlePull({
          clientGroupId: "g",
          cookie: first.cookie,
          subscriptions: allTodos,
        });
        expect(second.patch).toEqual([{ _tag: "Del", collection: "todos", id: "2" }]);
      })
    )
  );
});

// Single mutations for the READ COMMITTED model below.
const setMutation = (mutationId: number) => ({
  clientId: "c1",
  mutationId,
  mutator: "todo/set",
  args: { id: "1" },
  createdAt: 0,
});
const parkMutation = (mutationId: number) => ({
  clientId: "c1",
  mutationId,
  mutator: "todo/park",
  args: { id: "1" },
  createdAt: 0,
});

// A mutator whose handler parks on its first call (see `makeParkable`).
const parkTodo = Mutator.make("todo/park", Schema.Struct({ id: Schema.String }));

/**
 * A backend whose `todo/park` handler counts, then parks on its first call
 * until `release` is succeeded; `written` is succeeded once the parked call has
 * written. A second application does not wait on the gate, so it fails on its
 * counts rather than hanging.
 */
const makeParkable = (mock: Mock) =>
  Effect.gen(function* () {
    const ran = yield* Ref.make(0);
    const parks = yield* Ref.make(0);
    const written = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables,
      mutators: new Map<string, Mutator.AnyMutator>([
        [setTodo.name, setTodo],
        [parkTodo.name, parkTodo],
      ]),
      handlers: {
        "todo/set": () =>
          Ref.update(ran, (n) => n + 1).pipe(Effect.as<ReadonlyArray<Backend.ChangeHint>>([])),
        "todo/park": () =>
          Effect.gen(function* () {
            yield* Ref.update(ran, (n) => n + 1);
            if ((yield* Ref.getAndUpdate(parks, (n) => n + 1)) === 0) {
              yield* Deferred.succeed(written, undefined);
              yield* Deferred.await(release);
            }
            return [] as ReadonlyArray<Backend.ChangeHint>;
          }),
      },
    });
    return { backend, ran, written, release };
  });

describe("SqlBackend overlapping calls (READ COMMITTED model, issue #352)", () => {
  // The mock's transaction does not serialise, so two calls interleave the way
  // PostgreSQL READ COMMITTED lets them: a handler parked after its writes does
  // not hold a second call back. A parked call's claim is already in the
  // ledger, which is what the second call must see.
  it.effect("a copy of a mutation that is in flight is skipped, not applied again", () => {
    const mock = makeMock();
    return Effect.gen(function* () {
      const { backend, ran, written, release } = yield* makeParkable(mock);
      yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(1)]);

      const first = yield* Effect.forkChild(
        backend.applyMutations({ clientGroupId: "g" }, [parkMutation(2)])
      );
      yield* Deferred.await(written);

      // The copy runs while the first call is parked after its claim and writes.
      const copy = yield* backend.applyMutations({ clientGroupId: "g" }, [parkMutation(2)]);
      expect(copy.lastMutationIds).toEqual({ c1: 2 });

      yield* Deferred.succeed(release, undefined);
      const applied = yield* Fiber.join(first);
      expect(applied.lastMutationIds).toEqual({ c1: 2 });
      // set (1) and park (2) ran once each; the copy ran nothing.
      expect(yield* Ref.get(ran)).toBe(2);
      // The watermark after the parked call is 2, not a value the copy left behind.
      expect(yield* backend.lastMutationIds({ clientGroupId: "g" })).toEqual({ c1: 2 });
    });
  });

  it.effect(
    "a parked call that finishes after a later mutation never moves the watermark back",
    () => {
      const mock = makeMock();
      return Effect.gen(function* () {
        const { backend, written, release } = yield* makeParkable(mock);
        yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(1)]);

        const parked = yield* Effect.forkChild(
          backend.applyMutations({ clientGroupId: "g" }, [parkMutation(2)])
        );
        yield* Deferred.await(written);

        // Mutations 2 (a copy) and 3 commit while mutation 2's first call is parked.
        yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(2)]);
        const later = yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(3)]);
        expect(later.lastMutationIds).toEqual({ c1: 3 });

        yield* Deferred.succeed(release, undefined);
        const applied = yield* Fiber.join(parked);
        // A stale bump of 2 would move the watermark from 3 back to 2.
        expect(applied.lastMutationIds).toEqual({ c1: 3 });
        expect(yield* backend.lastMutationIds({ clientGroupId: "g" })).toEqual({ c1: 3 });
      });
    }
  );
});

// Runs one mutation whose handler records the watermark it sees, and returns
// that value with the call's result and the ledger after the call.
const observeOrder = (transactional: boolean) =>
  Effect.gen(function* () {
    const mock = makeMock({ transactional });
    const seen = yield* Ref.make(-1);
    const backend = SqlBackend.make({
      executor: mock.executor,
      tables,
      mutators: new Map<string, Mutator.AnyMutator>([[setTodo.name, setTodo]]),
      handlers: {
        "todo/set": () =>
          Effect.sync(() => mock.ledgerOf("g", "c1")).pipe(
            Effect.flatMap((last) => Ref.set(seen, last)),
            Effect.as<ReadonlyArray<Backend.ChangeHint>>([])
          ),
      },
    });
    const result = yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(1)]);
    return {
      seen: yield* Ref.get(seen),
      watermark: result.lastMutationIds,
      after: mock.ledgerOf("g", "c1"),
      claimIssued: mock.queries.some((fragment) => fragment.text.includes("RETURNING")),
    };
  });

describe("SqlBackend ledger order follows the executor's transactions (#342, #359)", () => {
  it.effect("with transactions the id is claimed before its handler runs", () =>
    observeOrder(true).pipe(
      Effect.map(({ seen, watermark, after }) => {
        expect(seen).toBe(1);
        expect(watermark).toEqual({ c1: 1 });
        expect(after).toBe(1);
      })
    )
  );

  it.effect("without transactions the handler runs first and the id is bumped after it", () =>
    observeOrder(false).pipe(
      Effect.map(({ seen, watermark, after, claimIssued }) => {
        // The watermark is still behind the id while the handler runs.
        expect(seen).toBe(0);
        expect(watermark).toEqual({ c1: 1 });
        expect(after).toBe(1);
        // Nothing was claimed, so nothing can be left claimed by a crash.
        expect(claimIssued).toBe(false);
      })
    )
  );
});

describe("SqlBackend watermark without transactions (#352)", () => {
  it.effect("a parked call that finishes after a later bump never moves the watermark back", () => {
    // D1's order: nothing is claimed, so a copy of mutation 2 runs while the
    // first call is parked (the double-apply #342 describes). The watermark is
    // still what the bump makes of it: the parked call's bump of 2 must not
    // undo the bump of 3.
    const mock = makeMock({ transactional: false });
    return Effect.gen(function* () {
      const { backend, written, release } = yield* makeParkable(mock);
      yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(1)]);

      const parked = yield* Effect.forkChild(
        backend.applyMutations({ clientGroupId: "g" }, [parkMutation(2)])
      );
      yield* Deferred.await(written);

      yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(2)]);
      const later = yield* backend.applyMutations({ clientGroupId: "g" }, [setMutation(3)]);
      expect(later.lastMutationIds).toEqual({ c1: 3 });

      yield* Deferred.succeed(release, undefined);
      const applied = yield* Fiber.join(parked);
      // A plain upsert of 2 would move the watermark from 3 back to 2.
      expect(applied.lastMutationIds).toEqual({ c1: 3 });
      expect(mock.ledgerOf("g", "c1")).toBe(3);
    });
  });
});
