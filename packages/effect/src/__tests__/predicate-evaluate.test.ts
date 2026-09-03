/**
 * `Predicate.evaluate` under ADR-0028: the worked NULL example, the Kleene
 * tables, and the per-operator table, checked node by node. The
 * differential harness in `@legation/sql` proves the same against a real
 * Postgres over a generated corpus; this file pins the specification's own
 * examples so a regression names the rule it broke.
 */
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Predicate from "../Predicate.js";

const T = Option.some(true);
const F = Option.some(false);
const U = Option.none<boolean>();

/** Render a verdict as the ADR's `T`/`F`/`U`. */
const verdict = (predicate: Predicate.Predicate, row: unknown): "T" | "F" | "U" =>
  Option.match(Predicate.evaluate(predicate, row), {
    onNone: () => "U" as const,
    onSome: (value) => (value ? ("T" as const) : ("F" as const)),
  });

describe("Predicate.evaluate (ADR-0028)", () => {
  describe("worked NULL example", () => {
    // Three rows in a `tasks` table: `n` has an explicit null, `a` lacks the
    // attribute, `c` is the control. "returned" means `test` is true.
    const n = { status: null };
    const a = {};
    const c = { status: "open" };

    const table: ReadonlyArray<
      [name: string, predicate: Predicate.Predicate, n: string, a: string, c: string]
    > = [
      ["ne(status, done)", Predicate.ne("status", "done"), "U", "U", "T"],
      ["Not(eq(status, done))", Predicate.not(Predicate.eq("status", "done")), "U", "U", "T"],
      ["In(status, [open, done])", Predicate.isIn("status", ["open", "done"]), "U", "U", "T"],
      ["NotIn(status, [done])", Predicate.notIn("status", ["done"]), "U", "U", "T"],
      ["Not(In(status, [done]))", Predicate.not(Predicate.isIn("status", ["done"])), "U", "U", "T"],
      ["IsNull(status)", Predicate.isNull("status"), "T", "T", "F"],
      ["eq(status, null) desugars to IsNull", Predicate.eq("status", null), "T", "T", "F"],
      ["ne(status, null) desugars to negated IsNull", Predicate.ne("status", null), "F", "F", "T"],
    ];

    for (const [name, predicate, onN, onA, onC] of table) {
      it(`${name}: n=${onN} a=${onA} c=${onC}`, () => {
        expect([verdict(predicate, n), verdict(predicate, a), verdict(predicate, c)]).toEqual([
          onN,
          onA,
          onC,
        ]);
        // `test` returns a row iff the verdict is T.
        expect([n, a, c].map((row) => Predicate.test(predicate, row))).toEqual(
          [onN, onA, onC].map((v) => v === "T")
        );
      });
    }
  });

  describe("Kleene connectives", () => {
    // Leaves with a fixed verdict over the row `{ x: 1 }`.
    const row = { x: 1 };
    const leaf = {
      T: Predicate.eq("x", 1),
      F: Predicate.eq("x", 2),
      U: Predicate.eq("missing", 1),
    };
    type V = keyof typeof leaf;
    const values: ReadonlyArray<V> = ["T", "U", "F"];

    const AND: Record<V, Record<V, V>> = {
      T: { T: "T", U: "U", F: "F" },
      U: { T: "U", U: "U", F: "F" },
      F: { T: "F", U: "F", F: "F" },
    };
    const OR: Record<V, Record<V, V>> = {
      T: { T: "T", U: "T", F: "T" },
      U: { T: "T", U: "U", F: "U" },
      F: { T: "T", U: "U", F: "F" },
    };
    const NOT: Record<V, V> = { T: "F", U: "U", F: "T" };

    it("AND and OR follow the tables; unknown is not absorbing", () => {
      for (const l of values) {
        for (const r of values) {
          expect({
            and: `${l} AND ${r} = ${verdict(Predicate.and(leaf[l], leaf[r]), row)}`,
            or: `${l} OR ${r} = ${verdict(Predicate.or(leaf[l], leaf[r]), row)}`,
          }).toEqual({ and: `${l} AND ${r} = ${AND[l][r]}`, or: `${l} OR ${r} = ${OR[l][r]}` });
        }
      }
    });

    it("NOT maps over the option", () => {
      expect(values.map((v) => `NOT ${v} = ${verdict(Predicate.not(leaf[v]), row)}`)).toEqual(
        values.map((v) => `NOT ${v} = ${NOT[v]}`)
      );
    });

    it("the empty And is true and the empty Or is false", () => {
      expect(Predicate.evaluate({ _tag: "And", predicates: [] }, row)).toEqual(T);
      expect(Predicate.evaluate({ _tag: "Or", predicates: [] }, row)).toEqual(F);
    });
  });

  describe("per-operator table", () => {
    it("True and Exists are Some(true)", () => {
      expect(Predicate.evaluate(Predicate.always, {})).toEqual(T);
      expect(
        Predicate.evaluate(
          Predicate.exists({ collection: "m", localField: "id", foreignField: "pid" }),
          {}
        )
      ).toEqual(T);
    });

    it("Compare is unknown on a NULL/absent field or a null literal", () => {
      expect(Predicate.evaluate(Predicate.eq("s", "x"), { s: null })).toEqual(U);
      expect(Predicate.evaluate(Predicate.gt("s", "x"), {})).toEqual(U);
      expect(Predicate.evaluate(Predicate.compare("eq", "s", null), { s: "x" })).toEqual(U);
      expect(Predicate.evaluate(Predicate.compare("ne", "s", null), { s: "x" })).toEqual(U);
      expect(Predicate.evaluate(Predicate.compare("lt", "s", null), { s: null })).toEqual(U);
    });

    it("Compare is unknown on a type mismatch and definite otherwise", () => {
      expect(Predicate.evaluate(Predicate.gt("n", "1"), { n: 2 })).toEqual(U);
      expect(Predicate.evaluate(Predicate.eq("n", "1"), { n: 1 })).toEqual(U);
      expect(Predicate.evaluate(Predicate.eq("n", 1), { n: { nested: true } })).toEqual(U);
      expect(Predicate.evaluate(Predicate.eq("n", 1), { n: 1 })).toEqual(T);
      expect(Predicate.evaluate(Predicate.eq("n", 0), { n: -0 })).toEqual(T);
      expect(Predicate.evaluate(Predicate.ne("n", 1), { n: 2 })).toEqual(T);
      expect(Predicate.evaluate(Predicate.lte("n", 1), { n: 2 })).toEqual(F);
    });

    it("orders text by code point and booleans false < true", () => {
      expect(Predicate.evaluate(Predicate.gt("s", "￿"), { s: "😀" })).toEqual(T);
      expect(Predicate.evaluate(Predicate.lt("s", "😀"), { s: "￿" })).toEqual(T);
      expect(Predicate.evaluate(Predicate.gt("b", false), { b: true })).toEqual(T);
      expect(Predicate.evaluate(Predicate.gte("b", true), { b: false })).toEqual(F);
      expect(Predicate.evaluate(Predicate.lte("b", false), { b: false })).toEqual(T);
    });

    it("In: match, null-in-list, miss, empty", () => {
      expect(Predicate.evaluate(Predicate.isIn("s", ["a", null]), { s: "a" })).toEqual(T);
      expect(Predicate.evaluate(Predicate.isIn("s", ["b", null]), { s: "a" })).toEqual(U);
      expect(Predicate.evaluate(Predicate.isIn("s", ["b"]), { s: "a" })).toEqual(F);
      expect(Predicate.evaluate(Predicate.isIn("s", []), { s: "a" })).toEqual(F);
      // An empty list is definite even on a NULL field: SQL renders it `1 = 0`.
      expect(Predicate.evaluate(Predicate.isIn("s", []), { s: null })).toEqual(F);
      expect(Predicate.evaluate(Predicate.isIn("s", ["a"]), {})).toEqual(U);
    });

    it("NotIn: match, null-in-list, miss, empty", () => {
      expect(Predicate.evaluate(Predicate.notIn("s", ["a", null]), { s: "a" })).toEqual(F);
      expect(Predicate.evaluate(Predicate.notIn("s", ["b", null]), { s: "a" })).toEqual(U);
      expect(Predicate.evaluate(Predicate.notIn("s", ["b"]), { s: "a" })).toEqual(T);
      expect(Predicate.evaluate(Predicate.notIn("s", []), { s: "a" })).toEqual(T);
      // An empty list is definite even on a NULL field: SQL renders it `1 = 1`.
      expect(Predicate.evaluate(Predicate.notIn("s", []), { s: null })).toEqual(T);
      expect(Predicate.evaluate(Predicate.notIn("s", ["a"]), {})).toEqual(U);
    });

    it("IsNull is always definite", () => {
      expect(Predicate.evaluate(Predicate.isNull("s"), { s: null })).toEqual(T);
      expect(Predicate.evaluate(Predicate.isNull("s"), {})).toEqual(T);
      expect(Predicate.evaluate(Predicate.isNull("s"), { s: "" })).toEqual(F);
      expect(Predicate.evaluate(Predicate.isNotNull("s"), { s: null })).toEqual(F);
      expect(Predicate.evaluate(Predicate.isNotNull("s"), {})).toEqual(F);
      expect(Predicate.evaluate(Predicate.isNotNull("s"), { s: 0 })).toEqual(T);
      expect(Predicate.evaluate(Predicate.isNull("s"), "not an object")).toEqual(T);
    });
  });

  describe("constructors and codec", () => {
    it("eq/ne desugar a null literal to IsNull; compare does not", () => {
      expect(Predicate.eq("s", null)).toEqual({ _tag: "IsNull", field: "s" });
      expect(Predicate.ne("s", null)).toEqual({ _tag: "IsNull", field: "s", negated: true });
      expect(Predicate.compare("eq", "s", null)).toEqual({
        _tag: "Compare",
        op: "eq",
        field: "s",
        value: null,
      });
    });

    it("IsNull and NotIn round-trip through PredicateSchema (wire-additive)", () => {
      const predicate = Predicate.and(
        Predicate.isNull("a"),
        Predicate.isNotNull("b"),
        Predicate.notIn("c", [1, "two", false]),
        Predicate.not(Predicate.isIn("d", [null]))
      );
      const encoded = Schema.encodeUnknownSync(Predicate.PredicateSchema)(predicate);
      const decoded = Schema.decodeUnknownSync(Predicate.PredicateSchema)(encoded);
      expect(decoded).toEqual(predicate);
      // An encoding from before the two nodes existed still decodes.
      expect(
        Schema.decodeUnknownSync(Predicate.PredicateSchema)({
          _tag: "Compare",
          op: "eq",
          field: "s",
          value: null,
        })
      ).toEqual(Predicate.compare("eq", "s", null));
    });

    it("existsValues leaves NULL and absent foreign values out", () => {
      const node: Predicate.ExistsNode = {
        collection: "m",
        localField: "id",
        foreignField: "pid",
        where: Predicate.always,
      };
      expect(
        Predicate.existsValues(node, [{ pid: "p1" }, { pid: null }, {}, { pid: "p1" }])
      ).toEqual(["p1"]);
    });

    it("hasExists and resolveExists are total over the new nodes", () => {
      expect(Predicate.hasExists(Predicate.isNull("a"))).toBe(false);
      expect(Predicate.hasExists(Predicate.notIn("a", [1]))).toBe(false);
    });
  });
});
