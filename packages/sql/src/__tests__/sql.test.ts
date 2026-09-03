/**
 * Sql translator tests: predicate → parameterised WHERE on both dialects,
 * exact under ADR-0028 (#156): the collation clause on text operands, typed
 * binds with and without declared `kinds`, and the NULL-bearing forms whose
 * three-valued text must match `Predicate.evaluate`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Predicate } from "@legation/effect";
import * as Sql from "../Sql.js";

describe("Sql.compileWhere", () => {
  it("compiles comparisons, IN, and boolean structure", () => {
    expect(Sql.compileWhere(Predicate.eq("status", "open"))).toEqual({
      text: `"status" COLLATE BINARY = ?`,
      params: ["open"],
    });
    expect(
      Sql.compileWhere(
        Predicate.and(Predicate.eq("status", "open"), Predicate.isIn("priority", [1, 2]))
      )
    ).toEqual({
      text: `"status" COLLATE BINARY = ? AND "priority" IN (?, ?)`,
      params: ["open", 1, 2],
    });
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
    expect(Sql.compileWhere(Predicate.notIn("x", ["a", "b"]), Sql.postgres)).toEqual({
      text: `"x" COLLATE "C" NOT IN ($1, $2)`,
      params: ["a", "b"],
    });
    // Empty `In` is FALSE and empty `NotIn` is TRUE (ADR-0028 §3), no binds.
    expect(Sql.compileWhere(Predicate.isIn("x", []))).toEqual({ text: `1 = 0`, params: [] });
    expect(Sql.compileWhere(Predicate.notIn("x", []))).toEqual({ text: `1 = 1`, params: [] });
    expect(Sql.compileWhere(Predicate.isIn("x", []), Sql.postgres)).toEqual({
      text: `1 = 0`,
      params: [],
    });
    expect(Sql.compileWhere(Predicate.notIn("x", []), Sql.postgres)).toEqual({
      text: `1 = 1`,
      params: [],
    });
  });

  it("keeps the NULL-bearing forms three-valued on both dialects", () => {
    // `ne`, `Not` and `In` compile to plain SQL whose result is unknown on a
    // NULL column, which is exactly what `Predicate.evaluate` says; no
    // `OR col IS NULL` widening (the old "superset" claim) is emitted.
    expect(Sql.compileWhere(Predicate.ne("status", "done"))).toEqual({
      text: `"status" COLLATE BINARY <> ?`,
      params: ["done"],
    });
    expect(Sql.compileWhere(Predicate.ne("status", "done"), Sql.postgres)).toEqual({
      text: `"status" COLLATE "C" <> $1`,
      params: ["done"],
    });
    expect(Sql.compileWhere(Predicate.not(Predicate.eq("status", "done")))).toEqual({
      text: `NOT ("status" COLLATE BINARY = ?)`,
      params: ["done"],
    });
    expect(Sql.compileWhere(Predicate.not(Predicate.eq("status", "done")), Sql.postgres)).toEqual({
      text: `NOT ("status" COLLATE "C" = $1)`,
      params: ["done"],
    });
    expect(Sql.compileWhere(Predicate.isIn("status", ["open", "done"]))).toEqual({
      text: `"status" COLLATE BINARY IN (?, ?)`,
      params: ["open", "done"],
    });
    expect(Sql.compileWhere(Predicate.isIn("status", ["open", "done"]), Sql.postgres)).toEqual({
      text: `"status" COLLATE "C" IN ($1, $2)`,
      params: ["open", "done"],
    });
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
    expect(Sql.compileWhere(Predicate.isIn("x", ["a", null]))).toEqual({
      text: `"x" COLLATE BINARY IN (?, ?)`,
      params: ["a", null],
    });
  });

  it('uses positional placeholders and COLLATE "C" for postgres', () => {
    expect(
      Sql.compileWhere(
        Predicate.and(Predicate.eq("status", "open"), Predicate.eq("owner", "ada")),
        Sql.postgres
      )
    ).toEqual({
      text: `"status" COLLATE "C" = $1 AND "owner" COLLATE "C" = $2`,
      params: ["open", "ada"],
    });
  });

  it("emits the collation clause for text operands only", () => {
    for (const dialect of [Sql.sqlite, Sql.postgres]) {
      const clause = `COLLATE ${dialect.textCollation}`;
      expect(Sql.compileWhere(Predicate.gt("s", "￿"), dialect).text).toBe(
        `"s" ${clause} > ${dialect.placeholder(1)}`
      );
      expect(Sql.compileWhere(Predicate.gt("n", 1), dialect).text).toBe(
        `"n" > ${dialect.placeholder(1)}`
      );
      expect(Sql.compileWhere(Predicate.gt("b", false), dialect).text).toBe(
        `"b" > ${dialect.placeholder(1)}`
      );
      expect(Sql.compileWhere(Predicate.isNull("s"), dialect).text).toBe(`"s" IS NULL`);
    }
  });

  it("binds and collates by the declared kinds", () => {
    const kinds: Sql.Kinds = {
      s: "text",
      t: "instant",
      i: "integer",
      d: "double",
      b: "boolean",
    };
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

  it("falls back to the literal's JS type without a kind", () => {
    // A string is treated as text (collation emitted) — an instant column
    // must declare its kind to suppress the clause.
    expect(Sql.compileWhere(Predicate.gt("t", "2020-02-29T12:34:56.789Z"), Sql.postgres)).toEqual({
      text: `"t" COLLATE "C" > $1`,
      params: ["2020-02-29T12:34:56.789Z"],
    });
    expect(
      Sql.compileWhere(Predicate.gt("t", "2020-02-29T12:34:56.789Z"), Sql.postgres, {
        kinds: { t: "instant" },
      })
    ).toEqual({ text: `"t" > $1`, params: ["2020-02-29T12:34:56.789Z"] });
    // A boolean binds per dialect either way.
    expect(Sql.compileWhere(Predicate.eq("done", false)).params).toEqual([0]);
    expect(Sql.compileWhere(Predicate.eq("done", true)).params).toEqual([1]);
    expect(Sql.compileWhere(Predicate.eq("done", false), Sql.postgres).params).toEqual([false]);
    // A field the map does not name falls back too.
    expect(
      Sql.compileWhere(Predicate.eq("other", "x"), Sql.sqlite, { kinds: { s: "text" } }).text
    ).toBe(`"other" COLLATE BINARY = ?`);
    // A `null`-only list has no type to fall back to: no clause.
    expect(Sql.compileWhere(Predicate.isIn("x", [null])).text).toBe(`"x" IN (?)`);
  });

  it("compiles a correlated Exists into a subquery, collating its inner text", () => {
    const exists = Predicate.exists({
      collection: "memberships",
      localField: "projectId",
      foreignField: "projectId",
      where: Predicate.eq("userId", "alice"),
    });
    expect(Sql.compileWhere(exists)).toEqual({
      text: `"projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" COLLATE BINARY = ?)`,
      params: ["alice"],
    });
    expect(Sql.compileWhere(exists, Sql.postgres)).toEqual({
      text: `"projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" COLLATE "C" = $1)`,
      params: ["alice"],
    });
    // The outer kinds describe the outer collection, not the subquery's.
    expect(Sql.compileWhere(exists, Sql.postgres, { kinds: { userId: "instant" } }).text).toContain(
      `"userId" COLLATE "C" = $1`
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
        where: Predicate.gt("at", "2020-02-29T12:34:56.789Z"),
        dialect: Sql.postgres,
        kinds: { at: "instant" },
      })
    ).toEqual({
      text: `SELECT * FROM "events" WHERE "at" > $1`,
      params: ["2020-02-29T12:34:56.789Z"],
    });
  });
});
