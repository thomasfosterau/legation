/**
 * The corpus oracle (#219 §2): over a seeded fixture corpus with typed
 * columns — text, integer, double, boolean, an instant column holding real
 * `Date`s, and an entity reference — the rows legation's `Predicate.test`
 * admits under the translated scope equal, row by row, the rows effect-auth's
 * own `ReadScope.matches` admits under the scope it compiled. effect-auth's
 * row holds an instant as epoch milliseconds; legation's holds it as
 * `Date#toISOString` text (ADR-0028 rule e), each derived from the same `Date`.
 *
 * Generated as `FilterCorpus` generates: Effect's `Random` under
 * `Random.withSeed`, so a seed reproduces the corpus and a failure reports it.
 *
 * The anonymous principal is `Anonymous::"anonymous"`, so effect-auth compiles
 * an "own" policy to false for it and its scope translates exactly like any other (#662).
 */
import { assert, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Random from "effect/Random";
import { Condition, Entity, Policy, ReadScope as AuthScope } from "@thomasfosterau/effect-auth";
import { type Authorization, Predicate } from "@thomasfosterau/legation";
import { Principal, ReadScopes } from "@thomasfosterau/legation-auth";
import { orFail } from "./support.js";

const SEED = 20261112;
const ROWS = 160;
const PREDICATES = 400;

const binding: AuthScope.Binding = {
  resourceType: "Item",
  attributes: {
    s: "Text",
    i: "Integer",
    d: "Double",
    b: "Boolean",
    t: "Instant",
    owner: { entity: "User" },
  },
  setFacts: {
    ownerIsFriend: { attribute: "owner", set: "friends" },
    tagIsWatched: { attribute: "s", set: "watched" },
  },
};

const members = {
  friends: ["user-bob", "user-carol"],
  watched: ["a", "😀"],
} satisfies Record<string, ReadonlyArray<string>>;

const map = orFail(
  ReadScopes.mapping({
    collection: "items",
    binding,
    attributes: { s: "s", i: "i", d: "d", b: "b", t: "t", owner: "ownerId" },
    sets: {
      friends: {
        source: "friends",
        maxAge: "1 hour",
        resolve: () => Effect.succeed(members.friends),
      },
      watched: {
        source: "watched",
        maxAge: "1 hour",
        resolve: () => Effect.succeed(members.watched),
      },
    },
  })
);

// ─── Pools ───────────────────────────────────────────────────────────────────

const texts: Arr.NonEmptyReadonlyArray<string> = ["", "a", "b", "é", "😀", "z", "a😀"];
const integers: Arr.NonEmptyReadonlyArray<number> = [-7, -1, 0, 1, 2, 100];
const doubles: Arr.NonEmptyReadonlyArray<number> = [-0.5, 0, 0.25, 1, 1.75];
const instants: Arr.NonEmptyReadonlyArray<number> = [
  ReadScopes.minInstant,
  -86_400_001,
  -1,
  0,
  1,
  1_700_000_000_000,
  1_700_000_000_001,
  ReadScopes.maxInstant,
];
const owners: Arr.NonEmptyReadonlyArray<string> = [
  "user-alice",
  "user-bob",
  "user-carol",
  "user-dave",
];
/** A row's owner, and an owner literal: a user, or the empty id the anonymous principal compiles to. */
const rowOwners: Arr.NonEmptyReadonlyArray<string> = [...owners, ""];

const int = (max: number) => Random.nextIntBetween(0, max, { halfOpen: true });
/** A uniform pick from a non-empty pool. */
const pick = <A>(xs: Arr.NonEmptyReadonlyArray<A>): Effect.Effect<A> =>
  Effect.map(int(xs.length), (index) => Option.getOrElse(Arr.get(xs, index), () => xs[0]));

// ─── Rows ────────────────────────────────────────────────────────────────────

/** One generated row: a field is a value, `null`, or absent (`undefined`). */
interface CorpusRow {
  readonly id: string;
  readonly s: string | null | undefined;
  readonly i: number | null | undefined;
  readonly d: number | null | undefined;
  readonly b: boolean | null | undefined;
  readonly t: Date | null | undefined;
  readonly owner: string | null | undefined;
}

/** A field value: from the pool, or (about one in five) NULL or absent. */
const field = <A>(pool: Arr.NonEmptyReadonlyArray<A>): Effect.Effect<A | null | undefined> =>
  pick<A | null | undefined>([...pool, ...pool, null, undefined]);

const generateRow = (index: number): Effect.Effect<CorpusRow> =>
  Effect.all(
    {
      s: field(texts),
      i: field(integers),
      d: field(doubles),
      b: field([true, false]),
      // A real Date, as a row codec decodes an instant column.
      t: Effect.map(field(instants), (ms) =>
        P.isNumber(ms) ? DateTime.toDateUtc(DateTime.makeUnsafe(ms)) : ms
      ),
      owner: field(rowOwners),
    },
    { concurrency: 1 }
  ).pipe(Effect.map((fields) => ({ id: `r${index}`, ...fields })));

/** The row as effect-auth binds it: the instant as epoch milliseconds. */
const authRowOf = (row: CorpusRow): AuthScope.Row => ({
  s: row.s,
  i: row.i,
  d: row.d,
  b: row.b,
  t: P.isDate(row.t) ? row.t.getTime() : row.t,
  owner: row.owner,
});

/** The row as legation stores it: the instant as ISO text, the edge under its key, absent fields absent. */
const legationRowOf = (row: CorpusRow): Readonly<Record<string, Predicate.Literal>> => {
  const entries: ReadonlyArray<readonly [string, Predicate.Literal | undefined]> = [
    ["id", row.id],
    ["s", row.s],
    ["i", row.i],
    ["d", row.d],
    ["b", row.b],
    ["t", P.isDate(row.t) ? row.t.toISOString() : row.t],
    ["ownerId", row.owner],
  ];
  return R.fromEntries(
    entries.flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const]))
  );
};

// ─── Predicates ──────────────────────────────────────────────────────────────

const ops = ["lt", "lte", "gt", "gte"] as const;

const eqOf = (attribute: string, value: AuthScope.Scalar): AuthScope.Predicate => ({
  _tag: "Eq",
  attribute,
  value,
});
const compareOf = (
  op: (typeof ops)[number],
  attribute: string,
  value: AuthScope.Scalar
): AuthScope.Predicate => ({ _tag: "Compare", op, attribute, value });

/** One generator per leaf shape, every literal of its column's kind. */
const leaves: Arr.NonEmptyReadonlyArray<Effect.Effect<AuthScope.Predicate>> = [
  Effect.map(pick(texts), (v) => eqOf("s", AuthScope.text(v))),
  Effect.map(pick(integers), (v) => eqOf("i", AuthScope.integer(v))),
  Effect.map(pick(doubles), (v) => eqOf("d", AuthScope.double(v))),
  Effect.map(pick([true, false]), (v) => eqOf("b", AuthScope.boolean(v))),
  Effect.map(pick(instants), (v) => eqOf("t", AuthScope.instant(v))),
  Effect.map(pick(rowOwners), (v) => eqOf("owner", AuthScope.text(v))),
  Effect.map(Effect.all([pick(ops), pick(integers)], { concurrency: 1 }), ([op, v]) =>
    compareOf(op, "i", AuthScope.integer(v))
  ),
  Effect.map(Effect.all([pick(ops), pick(doubles)], { concurrency: 1 }), ([op, v]) =>
    compareOf(op, "d", AuthScope.double(v))
  ),
  Effect.map(Effect.all([pick(ops), pick(instants)], { concurrency: 1 }), ([op, v]) =>
    compareOf(op, "t", AuthScope.instant(v))
  ),
  Effect.map(pick(["s", "i", "d", "b", "t", "owner"]), (attribute) => ({
    _tag: "IsNull" as const,
    attribute,
  })),
  Effect.map(
    pick([
      { attribute: "owner", set: "friends" },
      { attribute: "s", set: "watched" },
    ]),
    ({ attribute, set }) => ({ _tag: "InSet" as const, attribute, set })
  ),
];

const leaf: Effect.Effect<AuthScope.Predicate> = Effect.flatten(pick(leaves));

/** A list of one to three sub-predicates one level down. */
const children = (depth: number): Effect.Effect<ReadonlyArray<AuthScope.Predicate>> =>
  Effect.flatMap(int(3), (n) =>
    Effect.forEach(Arr.range(0, n), () => generatePredicate(depth - 1), { concurrency: 1 })
  );

/** A depth-bounded predicate: `And` / `Or` / `Not` over leaves, every operator covered. */
const generatePredicate = (depth: number): Effect.Effect<AuthScope.Predicate> =>
  depth <= 0
    ? leaf
    : Effect.flatten(
        pick<Effect.Effect<AuthScope.Predicate>>([
          Effect.map(children(depth), (predicates) => ({ _tag: "And" as const, predicates })),
          Effect.map(children(depth), (predicates) => ({ _tag: "Or" as const, predicates })),
          Effect.map(generatePredicate(depth - 1), (predicate) => ({
            _tag: "Not" as const,
            predicate,
          })),
          leaf,
          leaf,
        ])
      );

// ─── The oracle ──────────────────────────────────────────────────────────────

const inSet = (set: string, value: string | number | boolean) =>
  P.isString(value) &&
  ((set === "friends" && members.friends.includes(value)) ||
    (set === "watched" && members.watched.includes(value)));

const bindings = HashMap.make(["friends", members.friends], ["watched", members.watched]);

/** Whether legation admits a row under a translated scope, its named sets bound. */
const legationAdmits = (translated: Authorization.ReadScope, row: CorpusRow): boolean =>
  Match.valueTags(translated, {
    AllowAll: () => true,
    Deny: () => false,
    Filter: ({ predicate }) =>
      Predicate.test(Predicate.bindSets(predicate, bindings), legationRowOf(row)),
  });

/** The ids legation admits under the translated scope, and the ids effect-auth admits. */
const admitted = (scope: AuthScope.ReadScope, rows: ReadonlyArray<CorpusRow>) => {
  const translated = orFail(ReadScopes.translate(scope, map));
  return {
    legation: rows.filter((row) => legationAdmits(translated, row)).map((row) => row.id),
    effectAuth: rows
      .filter((row) => AuthScope.matches(scope, authRowOf(row), inSet))
      .map((row) => row.id),
  };
};

/** Whether a set of admitted ids discriminates: some rows, not all. */
const discriminates = (ids: ReadonlyArray<string>) =>
  Arr.isReadonlyArrayNonEmpty(ids) && ids.length < ROWS;

const corpus = Effect.gen(function* () {
  const rows = yield* Effect.forEach(Arr.range(0, ROWS - 1), generateRow, { concurrency: 1 });
  const predicates = yield* Effect.forEach(
    Arr.range(0, PREDICATES - 1),
    (index) => generatePredicate(1 + (index % 3)),
    { concurrency: 1 }
  );
  return { rows, predicates };
}).pipe(Random.withSeed(SEED));

const resource = (name: string) => Condition.attr("resource", name);

/** A policy set over every column kind: ownership, two named sets, an instant forbid, a boolean forbid. */
const policies = [
  Policy.permit({
    id: "own",
    resource: Policy.isType("Item"),
    when: Condition.eq(resource("owner"), Condition.principal),
  }),
  Policy.permit({
    id: "friends-recent",
    resource: Policy.isType("Item"),
    when: Condition.and(
      Condition.eq(Condition.attr("context", "ownerIsFriend"), Condition.lit(true)),
      Condition.gte(resource("t"), Condition.lit(0))
    ),
  }),
  Policy.permit({
    id: "watched-scored",
    resource: Policy.isType("Item"),
    when: Condition.and(
      Condition.eq(Condition.attr("context", "tagIsWatched"), Condition.lit(true)),
      Condition.gt(resource("d"), Condition.lit(0.25))
    ),
  }),
  Policy.forbid({
    id: "embargo",
    resource: Policy.isType("Item"),
    when: Condition.gt(resource("t"), Condition.lit(1_700_000_000_000)),
  }),
  Policy.forbid({
    id: "hidden",
    resource: Policy.isType("Item"),
    when: Condition.eq(resource("b"), Condition.lit(true)),
  }),
];

/** The scope effect-auth compiles for the anonymous principal (`Anonymous::"anonymous"`). */
const anonymousScopeOf = (set: ReadonlyArray<Policy.DeclarativePolicy>): AuthScope.ReadScope => {
  const compiled = AuthScope.compile(set, binding, {
    principal: ReadScopes.principalRef(Principal.anonymous),
    action: Entity.ref("Action", "read"),
  });
  return P.isTagged(compiled, "Exact") ? compiled.scope : assert.fail("expected Exact");
};

describe("the corpus oracle: translated scopes admit exactly what effect-auth admits", () => {
  it.effect(`agrees row by row over ${PREDICATES} generated predicates (seed ${SEED})`, () =>
    Effect.gen(function* () {
      const { rows, predicates } = yield* corpus;
      // The corpus is real: it carries instants as Dates, NULLs and absences.
      expect(rows.some((row) => P.isDate(row.t))).toBe(true);
      expect(rows.some((row) => row.t === null)).toBe(true);
      expect(rows.some((row) => row.t === undefined)).toBe(true);
      const results = predicates.map((predicate, index) => {
        const { legation, effectAuth } = admitted({ _tag: "Filter", predicate, sets: [] }, rows);
        return { index, predicate, legation, effectAuth };
      });
      const disagreements = results.filter(
        ({ legation, effectAuth }) => legation.join(",") !== effectAuth.join(",")
      );
      // Reported with the seed, so a failure reproduces.
      expect(
        disagreements.slice(0, 3).map(({ index, predicate, legation, effectAuth }) => ({
          seed: SEED,
          index,
          predicate,
          legation,
          effectAuth,
        }))
      ).toEqual([]);
      // The predicates discriminate: most admit some rows and not others.
      expect(results.filter(({ legation }) => discriminates(legation)).length).toBeGreaterThan(
        PREDICATES / 3
      );
      // The corpus exercises the empty owner, as a row value and as a literal.
      expect(rows.some((row) => row.owner === "")).toBe(true);
    })
  );

  it.effect("agrees on scopes effect-auth compiled from policies, instants included", () =>
    Effect.gen(function* () {
      const { rows } = yield* corpus;
      const compiled = owners.map((user) => ({
        user,
        compiled: AuthScope.compile(policies, binding, {
          principal: Entity.ref("User", user),
          action: Entity.ref("Action", "read"),
        }),
      }));
      const exact = compiled.flatMap(({ user, compiled: result }) =>
        P.isTagged(result, "Exact") ? [{ user, scope: result.scope }] : []
      );
      expect(exact).toHaveLength(owners.length);
      const results = exact.map(({ user, scope }) => {
        // Translated for the signed-in principal, as the auth filter does: no narrowing.
        const { legation, effectAuth } = admitted(scope, rows);
        return { user, legation, effectAuth };
      });
      expect(results.map(({ user, legation }) => ({ user, ids: legation }))).toEqual(
        results.map(({ user, effectAuth }) => ({ user, ids: effectAuth }))
      );
      expect(results.every(({ effectAuth }) => discriminates(effectAuth))).toBe(true);
    })
  );

  it.effect("agrees for the anonymous principal, whom an owner policy never names (#662)", () =>
    Effect.gen(function* () {
      const { rows } = yield* corpus;
      const result = admitted(anonymousScopeOf(policies), rows);
      expect(result.legation).toEqual(result.effectAuth);
      // Exactly as if the "own" policy did not exist: no row is owned signed out.
      const withoutOwn = anonymousScopeOf(policies.filter((policy) => policy.id !== "own"));
      expect(result.legation).toEqual(
        rows
          .filter((row) => AuthScope.matches(withoutOwn, authRowOf(row), inSet))
          .map((row) => row.id)
      );
      expect(discriminates(result.legation)).toBe(true);
    })
  );
});
