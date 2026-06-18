/** Sql translator tests: predicate → parameterized WHERE, both dialects. */
import { describe, expect, it } from "@effect/vitest";
import { Predicate } from "@thomasfosterau/effect-sync-core";
import * as Sql from "../Sql.js";

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
  });

  it("handles null equality and empty sets without binds", () => {
    expect(Sql.compileWhere(Predicate.eq("x", null))).toEqual({ text: `"x" IS NULL`, params: [] });
    expect(Sql.compileWhere(Predicate.ne("x", null))).toEqual({
      text: `"x" IS NOT NULL`,
      params: [],
    });
    expect(Sql.compileWhere(Predicate.isIn("x", []))).toEqual({ text: `1 = 0`, params: [] });
    expect(Sql.compileWhere(Predicate.always)).toEqual({ text: `1 = 1`, params: [] });
  });

  it("uses positional placeholders for postgres", () => {
    expect(
      Sql.compileWhere(
        Predicate.and(Predicate.eq("status", "open"), Predicate.eq("owner", "ada")),
        Sql.postgres
      )
    ).toEqual({ text: `"status" = $1 AND "owner" = $2`, params: ["open", "ada"] });
  });

  it("compiles a correlated Exists into a subquery", () => {
    expect(
      Sql.compileWhere(
        Predicate.exists({
          collection: "memberships",
          localField: "projectId",
          foreignField: "projectId",
          where: Predicate.eq("userId", "alice"),
        })
      )
    ).toEqual({
      text: `"projectId" IN (SELECT "projectId" FROM "memberships" WHERE "userId" = ?)`,
      params: ["alice"],
    });
  });

  it("compiles a full SELECT", () => {
    expect(Sql.compileSelect({ table: "todos", where: Predicate.eq("done", false) })).toEqual({
      text: `SELECT * FROM "todos" WHERE "done" = ?`,
      params: [false],
    });
  });
});
