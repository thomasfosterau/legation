/**
 * Sql translator tests: predicate → parameterised WHERE on both dialects,
 * exact under ADR-0028 (#156): the collation clause on declared-text
 * operands, typed binds by declared kind, the plain forms without a
 * declaration, and the NULL-bearing forms whose three-valued text must match
 * `Predicate.evaluate`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Predicate } from "@thomasfosterau/legation-effect";
import * as Sql from "../Sql.js";

const kinds: Sql.Kinds = {
  s: "text",
  status: "text",
  owner: "text",
  t: "instant",
  i: "integer",
  d: "double",
  b: "boolean",
};

describe("Sql.compileWhere", () => {
  it("compiles comparisons, IN, and boolean structure", () => {
    expect(Sql.compileWhere(Predicate.eq("status", "open"))).toEqual({
      text: `"status" = ?`,
      params: ["open"],
    });
    expect(
      Sql.compileWhere(
        Predicate.and(Predicate.eq("status", "open"), Predicate.isIn("priority", [1, 2]))
      )
    ).toEqual({ text: `"status" = ? AND "priority" IN (?, ?)`, params: ["open", 1, 2] });
    expect(Sql.compileWhere(Predicate.or(Predicate.eq("a", 1), Predicate.eq("b", 2)))).toEqual({
      text: `("a" = ? OR "b" = ?)`,
      params: [1, 2],
    });
    expect(Sql.compileWhere(Predicate.not(Predicate.gt("age", 18)))).toEqual({
      text: `NOT ("age" > ?)`,
      params: [18],
    });
    expect(Sql.compileWhere(Predicate.always)).toEqual({ text: `1 = 1`, params: [] });
  });

  it("compiles isnull and nin, and the empty lists to constants", () => {
    expect(Sql.compileWhere(Predicate.isNull("x"))).toEqual({ text: `"x" IS NULL`, params: [] });
    expect(Sql.compileWhere(Predicate.isNotNull("x"))).toEqual({
      text: `"x" IS NOT NULL`,
      params: [],
    });
    // ADR-0028 §5: `eq(f, null)` / `ne(f, null)` desugar to `IsNull`.
    expect(Sql.compileWhere(Predicate.eq("x", null))).toEqual({ text: `"x" IS NULL`, params: [] });
    expect(Sql.compileWhere(Predicate.ne("x", null))).toEqual({
      text: `"x" IS NOT NULL`,
      params: [],
    });
    expect(Sql.compileWhere(Predicate.notIn("x", [1, 2]))).toEqual({
      text: `"x" NOT IN (?, ?)`,
      params: [1, 2],
    });
    expect(Sql.compileWhere(Predicate.notIn("s", ["a", "b"]), Sql.postgres, { kinds })).toEqual({
      text: `"s" COLLATE "C" NOT IN ($1, $2)`,
      params: ["a", "b"],
    });
    // Empty `In` is FALSE and empty `NotIn` is TRUE (ADR-0028 §3), no binds.
    expect(Sql.compileWhere(Predicate.isIn("x", []))).toEqual({ text: `1 = 0`, params: [] });
    expect(Sql.compileWhere(Predicate.notIn("x", []))).toEqual({ text: `1 = 1`, params: [] });
    expect(Sql.compileWhere(Predicate.isIn("s", []), Sql.postgres, { kinds })).toEqual({
      text: `1 = 0`,
      params: [],
    });
    expect(Sql.compileWhere(Predicate.notIn("s", []), Sql.postgres, { kinds })).toEqual({
      text: `1 = 1`,
      params: [],
    });
  });

  it("keeps the NULL-bearing forms three-valued on both dialects", () => {
    // `ne`, `Not` and `In` compile to plain SQL whose result is unknown on a
    // NULL column, which is exactly what `Predicate.evaluate` says; no
    // `OR col IS NULL` widening (the old "superset" claim) is emitted.
    expect(Sql.compileWhere(Predicate.ne("status", "done"), Sql.sqlite, { kinds })).toEqual({
      text: `"status" COLLATE BINARY <> ?`,
      params: ["done"],
    });
    expect(Sql.compileWhere(Predicate.ne("status", "done"), Sql.postgres, { kinds })).toEqual({
      text: `"status" COLLATE "C" <> $1`,
      params: ["done"],
    });
    expect(
      Sql.compileWhere(Predicate.not(Predicate.eq("status", "done")), Sql.sqlite, { kinds })
    ).toEqual({ text: `NOT ("status" COLLATE BINARY = ?)`, params: ["done"] });
    expect(
      Sql.compileWhere(Predicate.not(Predicate.eq("status", "done")), Sql.postgres, { kinds })
    ).toEqual({ text: `NOT ("status" COLLATE "C" = $1)`, params: ["done"] });
    expect(
      Sql.compileWhere(Predicate.isIn("status", ["open", "done"]), Sql.sqlite, { kinds })
    ).toEqual({ text: `"status" COLLATE BINARY IN (?, ?)`, params: ["open", "done"] });
    expect(
      Sql.compileWhere(Predicate.isIn("status", ["open", "done"]), Sql.postgres, { kinds })
    ).toEqual({ text: `"status" COLLATE "C" IN ($1, $2)`, params: ["open", "done"] });
    // The deprecated wire form with a `null` literal binds NULL (unknown for
    // every row); a NULL among `In` values binds too.
    expect(Sql.compileWhere(Predicate.compare("eq", "x", null))).toEqual({
      text: `"x" = ?`,
      params: [null],
    });
    expect(Sql.compileWhere(Predicate.compare("ne", "x", null), Sql.postgres)).toEqual({
      text: `"x" <> $1`,
      params: [null],
    });
    expect(Sql.compileWhere(Predicate.isIn("s", ["a", null]), Sql.sqlite, { kinds })).toEqual({
      text: `"s" COLLATE BINARY IN (?, ?)`,
      params: ["a", null],
    });
  });

  it("uses positional placeholders for postgres", () => {
    const where = Predicate.and(Predicate.eq("status", "open"), Predicate.eq("owner", "ada"));
    expect(Sql.compileWhere(where, Sql.postgres)).toEqual({
      text: `"status" = $1 AND "owner" = $2`,
      params: ["open", "ada"],
    });
    expect(Sql.compileWhere(where, Sql.postgres, { kinds })).toEqual({
      text: `"status" COLLATE "C" = $1 AND "owner" COLLATE "C" = $2`,
      params: ["open", "ada"],
    });
  });

  it("emits the collation clause for declared-text operands only", () => {
    for (const dialect of [Sql.sqlite, Sql.postgres]) {
      const clause = `COLLATE ${dialect.textCollation}`;
      const ph = dialect.placeholder(1);
      expect(Sql.compileWhere(Predicate.gt("s", "￿"), dialect, { kinds }).text).toBe(
        `"s" ${clause} > ${ph}`
      );
      expect(
        Sql.compileWhere(Predicate.gt("t", "2020-01-01T00:00:00.000Z"), dialect, { kinds }).text
      ).toBe(`"t" > ${ph}`);
      expect(Sql.compileWhere(Predicate.gt("i", 1), dialect, { kinds }).text).toBe(`"i" > ${ph}`);
      expect(Sql.compileWhere(Predicate.gt("b", false), dialect, { kinds }).text).toBe(
        `"b" > ${ph}`
      );
      expect(Sql.compileWhere(Predicate.isNull("s"), dialect, { kinds }).text).toBe(`"s" IS NULL`);
    }
  });

  it("never collates without a declaration, whatever the literal", () => {
    // A string literal alone says nothing about the column: it may be bound
    // against a uuid, date, enum or timestamptz column, none of which
    // accepts a collation (Postgres: "collations are not supported by type
    // …"). The clause needs `kinds[field] === "text"`.
    expect(Sql.compileWhere(Predicate.eq("id", "9d1c…"), Sql.postgres)).toEqual({
      text: `"id" = $1`,
      params: ["9d1c…"],
    });
    expect(Sql.compileWhere(Predicate.gt("t", "2020-02-29T12:34:56.789Z"), Sql.postgres)).toEqual({
      text: `"t" > $1`,
      params: ["2020-02-29T12:34:56.789Z"],
    });
    expect(Sql.compileWhere(Predicate.isIn("s", ["a", "b"]), Sql.postgres)).toEqual({
      text: `"s" IN ($1, $2)`,
      params: ["a", "b"],
    });
    // A field the map does not name is undeclared too.
    expect(
      Sql.compileWhere(Predicate.eq("other", "x"), Sql.postgres, { kinds: { s: "text" } }).text
    ).toBe(`"other" = $1`);
    // Booleans still bind per dialect without a declaration.
    expect(Sql.compileWhere(Predicate.eq("done", false)).params).toEqual([0]);
    expect(Sql.compileWhere(Predicate.eq("done", true)).params).toEqual([1]);
    expect(Sql.compileWhere(Predicate.eq("done", false), Sql.postgres).params).toEqual([false]);
  });

  it("binds and collates by the declared kinds", () => {
    const where = Predicate.and(
      Predicate.gt("s", "a"),
      Predicate.gt("t", "2020-02-29T12:34:56.789Z"),
      Predicate.gte("i", 7),
      Predicate.lt("d", 2.5),
      Predicate.eq("b", true)
    );
    expect(Sql.compileWhere(where, Sql.postgres, { kinds })).toEqual({
      text: `"s" COLLATE "C" > $1 AND "t" > $2 AND "i" >= $3 AND "d" < $4 AND "b" = $5`,
      params: ["a", "2020-02-29T12:34:56.789Z", 7, 2.5, true],
    });
    expect(Sql.compileWhere(where, Sql.sqlite, { kinds })).toEqual({
      text: `"s" COLLATE BINARY > ? AND "t" > ? AND "i" >= ? AND "d" < ? AND "b" = ?`,
      params: ["a", "2020-02-29T12:34:56.789Z", 7, 2.5, 1],
    });
    // Lists follow the same kinds: text `In` collates, instant `In` does not,
    // booleans bind per dialect.
    expect(
      Sql.compileWhere(
        Predicate.and(
          Predicate.isIn("s", ["a", "b"]),
          Predicate.notIn("t", ["1970-01-01T00:00:00.000Z"]),
          Predicate.isIn("b", [true, false])
        ),
        Sql.sqlite,
        { kinds }
      )
    ).toEqual({
      text: `"s" COLLATE BINARY IN (?, ?) AND "t" NOT IN (?) AND "b" IN (?, ?)`,
      params: ["a", "b", "1970-01-01T00:00:00.000Z", 1, 0],
    });
  });

  it("binds a cross-type literal as NULL under a declared kind (rule (d))", () => {
    // `Predicate.evaluate` says unknown for a mismatched pair; so must the
    // SQL, and SQLite's affinity coercion (`"i" = '1'` is true there) must
    // never see the raw string.
    expect(Sql.compileWhere(Predicate.ne("i", "1"), Sql.sqlite, { kinds })).toEqual({
      text: `"i" <> ?`,
      params: [null],
    });
    expect(Sql.compileWhere(Predicate.eq("s", 7), Sql.postgres, { kinds })).toEqual({
      text: `"s" COLLATE "C" = $1`,
      params: [null],
    });
    expect(Sql.compileWhere(Predicate.eq("b", 1), Sql.sqlite, { kinds }).params).toEqual([null]);
    expect(Sql.compileWhere(Predicate.eq("t", 0), Sql.sqlite, { kinds }).params).toEqual([null]);
    // In a list a mismatched literal matches nothing and is dropped; a list
    // left with none binds one NULL (unknown, as `evaluate` says when no
    // listed literal has the field's type); a NULL in the list stays.
    expect(Sql.compileWhere(Predicate.isIn("i", [1, "x"]), Sql.sqlite, { kinds })).toEqual({
      text: `"i" IN (?)`,
      params: [1],
    });
    expect(Sql.compileWhere(Predicate.notIn("i", ["x", "y"]), Sql.sqlite, { kinds })).toEqual({
      text: `"i" NOT IN (?)`,
      params: [null],
    });
    expect(Sql.compileWhere(Predicate.isIn("i", ["x", null]), Sql.sqlite, { kinds })).toEqual({
      text: `"i" IN (?)`,
      params: [null],
    });
    // A conforming literal is untouched even when it looks numeric.
    expect(Sql.compileWhere(Predicate.eq("s", "1"), Sql.sqlite, { kinds }).params).toEqual(["1"]);
    // Without a declaration there is no kind to mismatch.
    expect(Sql.compileWhere(Predicate.ne("i", "1")).params).toEqual(["1"]);
  });

  it("compiles a correlated Exists into a subquery, collating by the foreign kinds", () => {
    const exists = Predicate.exists({
      collection: "memberships",
      localField: "projectId",
      foreignField: "projectId",
      where: Predicate.eq("userId", "alice"),
    });
    expect(Sql.compileWhere(exists)).toEqual({
      text: `"projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" = ?)`,
      params: ["alice"],
    });
    const foreignKinds = { memberships: { userId: "text" } } as const;
    expect(Sql.compileWhere(exists, Sql.postgres, { foreignKinds })).toEqual({
      text: `"projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" COLLATE "C" = $1)`,
      params: ["alice"],
    });
    // The outer `kinds` describe the outer collection, not the subquery's.
    expect(Sql.compileWhere(exists, Sql.postgres, { kinds: { userId: "text" } }).text).toContain(
      `WHERE "userId" = $1`
    );
    // A nested Exists picks its own collection's kinds.
    const nested = Predicate.exists({
      collection: "projects",
      localField: "projectId",
      foreignField: "id",
      where: exists,
    });
    expect(
      Sql.compileWhere(nested, Sql.postgres, {
        foreignKinds: { projects: { id: "text" }, memberships: { userId: "text" } },
      }).text
    ).toBe(
      `"projectId" IN (SELECT "id" FROM "projects" WHERE "projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" COLLATE "C" = $1))`
    );
  });

  it("compiles a full SELECT, passing kinds through", () => {
    expect(Sql.compileSelect({ table: "todos", where: Predicate.eq("done", false) })).toEqual({
      text: `SELECT * FROM "todos" WHERE "done" = ?`,
      params: [0],
    });
    expect(
      Sql.compileSelect({
        table: "events",
        where: Predicate.and(
          Predicate.gt("at", "2020-02-29T12:34:56.789Z"),
          Predicate.eq("kind", "x")
        ),
        dialect: Sql.postgres,
        kinds: { at: "instant", kind: "text" },
      })
    ).toEqual({
      text: `SELECT * FROM "events" WHERE "at" > $1 AND "kind" COLLATE "C" = $2`,
      params: ["2020-02-29T12:34:56.789Z", "x"],
    });
  });
});
