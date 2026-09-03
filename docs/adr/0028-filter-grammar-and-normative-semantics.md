# ADR-0028: One filter grammar; Postgres-normative three-valued semantics

Date: 2026-09-02
Status: Accepted (issue #151; amends ADR-0026 in part)

## Context

Issue #148 found that one predicate AST has three interpreters, and they
disagree.

- `Predicate.test` (`packages/effect/src/Predicate.ts`) is two-valued and
  uses strict `===`. `ne` is `!==`, so a row whose field is `null` or absent
  matches `ne("status", "done")`.
- `Sql.compileWhere` (`packages/sql/src/Sql.ts`) compiles the same node to
  `"status" <> $1`. In SQL that expression is NULL for a NULL column and the
  row is excluded. The module documents itself as a superset pre-filter, but
  on NULL rows it returns a strict subset of what `Predicate.test` returns.
- `JsonApiQuery.safeFilters` (`@legation/jsonapi`) is a lossy one-way URL
  encoder. It emits top-level `eq`/`In` conjuncts and drops everything else.
  No parser exists.

ADR-0026 and the comment on `Subset.comparator`
(`packages/effect/src/Subset.ts`) declared `Subset.apply` the sole
evaluation and ordering authority, with SQL a superset pre-filter that
`Subset.apply` finishes locally. That statement was true for order, cursor
and limit. It was never true for the `WHERE`, because the SQL pre-filter
already excluded rows the authority would have kept.

Two further pressures make this urgent. The commerce example's REST list
handlers are hand-written SQL. A service-worker façade (#149) that serves the
same URL from the replica would give different answers unless both derive
from one grammar. And the sync tier's filter surface is open: any field of a
mapped table is probe-able, so the semantics of every operator are part of
the authorisation story (ADR-0015, #154).

Empirical usage is small. Across four example apps there are 23 filter
sites: 16 `eq`, 2 `in`, nothing else. There is no relationship traversal, no
`Exists` construction and no NULL filter. The grammar can be fixed now
without migrating anything that exists.

The grammar itself is designed in effect-jsonapi
(thomasfosterau/effect-jsonapi#82, E1). Its child issues
(thomasfosterau/effect-jsonapi#83 grammar, #84 per-attribute
`filterable`/`sortable`, #86 URL ⇄ AST codec, #85 canonical query string)
are open as of today; effect-jsonapi 0.12.0 does not carry them. That design
deliberately defers semantics, NULL handling and collation to this ADR.
Issue #156 defers the collation decision here too.

## Decision

### 1. Postgres is normative; every evaluator is an implementation

**Postgres semantics define what a filter means.** `Subset.apply`,
`Predicate.evaluate`, `Subset.comparator`, the Postgres and SQLite compilers
in `@legation/sql`, and the later IndexedDB evaluator (#158) are all
implementations. Each must agree with Postgres exactly, and that agreement is
proven by the differential harness (#153) with a real Postgres as the oracle.

This reverses ADR-0026's authority statement in part. `Subset.apply` remains
the shared JS implementation both client and server call, so client/server
agreement by construction still holds. It is no longer the definition of
correctness; Postgres is. ADR-0026's ordering decisions (id tie-break, total
order, no observer-local collation) stand unchanged.

"Filter grammar" is the public name of the language. `Predicate` is its
internal engine form and stays internal (CONTEXT.md).

### 2. The five rules

**(a) Three-valued logic, modelled as `Option<boolean>`.** `Some(true)`,
`Some(false)` and `None` (unknown). The connectives are Kleene's, written by
hand. They are explicitly _not_ `Option.zipWith` or `Option.all`, both of
which make `None` absorbing; `unknown AND false` must be `false`. The root
collapses with `Option.getOrElse(() => false)`: a row is returned iff the
predicate is `Some(true)`. That is Postgres `WHERE`.

**(b) Absent attribute ≡ NULL.** Field access returns `Option`. It is `None`
for SQL NULL, JSON `null` and an absent attribute alike. The current
`fieldValue` distinction between `undefined` and `null` disappears from
evaluation.

**(c) Text ordering is code-point order.** Postgres `COLLATE "C"` compares
UTF-8 bytes, which is code-point order. SQLite `BINARY` is bytewise too. JS
`<` compares UTF-16 code units and diverges only for astral characters
(U+10000 and above) against U+E000 to U+FFFF; the JS comparator therefore
compares code points, not code units. IndexedDB compares strings by UTF-16
code unit, so IndexedDB keys for text must be UTF-8 byte arrays. Filterable
and sortable text columns must be declared `COLLATE "C"` (section 4).

**(d) No cross-type comparison.** The typed URL codec
(thomasfosterau/effect-jsonapi#86) makes it unrepresentable: values are
typed literals matching the attribute schema, never raw strings. The sync
tier rejects it in `authorize` before evaluation (#154). For completeness
`evaluate` defines a mismatched pair (a number field against a string
literal) as `None`; the harness never generates one. SQLite's affinity
coercion (`1 = '1'` can be true) is exactly why both compilers bind
parameters with the declared attribute type (#156).

**(e) Numerics are `integer` and `double precision`; instants are ISO-8601
UTC text.** JS numbers are IEEE-754 doubles. Postgres columns are `integer`
(int4) or `double precision`; `bigint` and `numeric` are excluded because
they are not exactly representable as a JS number. `-0` equals `0`
everywhere. `NaN` and `Infinity` are excluded by the type rule; the codec
cannot produce them. Instants travel as strings in the fixed
`Date#toISOString` format (`YYYY-MM-DDTHH:mm:ss.sssZ`). That format is
fixed-width and UTC, so code-point order equals chronological order, and a
`text` column and a `timestamptz` column compare identically against such a
literal. The row codec is responsible for emitting the fixed format.

### 3. The operator core and its truth tables

The operator core is as fixed in thomasfosterau/effect-jsonapi#82 (E1).
Comparison operators: `eq ne lt lte gt gte in nin isnull`. Logical: `and or
not`. Relationship traversal, pattern matching, text search, and array/JSON
operators are excluded. The AST is an Effect Schema union owned by
effect-jsonapi:

| Node                           | Meaning                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `Compare { op, field, value }` | `op` is one of `eq ne lt lte gt gte`; `value` is a typed literal |
| `In { field, values }`         | membership in a literal list                                     |
| `NotIn { field, values }`      | `x NOT IN (a, b)`, which Postgres defines as `x <> a AND x <> b` |
| `IsNull { field, negated? }`   | the only way to test for NULL; NULL is not a literal             |
| `And \| Or \| Not`             | Kleene connectives                                               |

Fields reference the primary resource's declared attributes only. Surface
syntax, canonical encoding and the profile URI
(`https://…/profiles/filter-grammar/v1`) are effect-jsonapi's
(thomasfosterau/effect-jsonapi#83, #85) and are not restated here.

**Kleene connectives.** `T` = `Some(true)`, `F` = `Some(false)`, `U` =
`None`.

| AND | T   | U   | F   |
| --- | --- | --- | --- |
| T   | T   | U   | F   |
| U   | U   | U   | F   |
| F   | F   | F   | F   |

| OR  | T   | U   | F   |
| --- | --- | --- | --- |
| T   | T   | T   | T   |
| U   | T   | U   | U   |
| F   | T   | U   | F   |

| NOT | T   | U   | F   |
| --- | --- | --- | --- |
|     | F   | U   | T   |

As code: `Not` is `Option.map(not)`. `And` is `Some(false)` if any operand is
`Some(false)`, else `None` if any operand is `None`, else `Some(true)`; the
empty `And` is `Some(true)`. `Or` is `Some(true)` if any operand is
`Some(true)`, else `None` if any is `None`, else `Some(false)`; the empty
`Or` is `Some(false)`.

**Per-operator table.** "field" is the `Option` from field access; "literal"
is the typed value on the node.

| Node                              | Result                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `True`                            | `Some(true)`                                                                                                                                                                                |
| `Compare` (`eq ne lt lte gt gte`) | `None` if the field is `None` or the literal is NULL (wire compatibility, section 5); else `Some(op(left, right))` over same-typed operands; a type mismatch is `None`                      |
| `In`                              | `None` if the field is `None`; `Some(true)` on a match; `None` if no match and any listed literal is NULL; else `Some(false)`. Empty list: `Some(false)`                                    |
| `NotIn`                           | `None` if the field is `None`; `Some(false)` on a match; `None` if no match and any listed literal is NULL; else `Some(true)`. Empty list: `Some(true)`                                     |
| `IsNull`                          | Always definite: `Some(field is None)`, flipped when `negated`                                                                                                                              |
| `And` / `Or` / `Not`              | The Kleene tables above                                                                                                                                                                     |
| `Exists`                          | Server-only. A backend resolves it to `In` before evaluation (`resolveExists`), as today. On the client `evaluate` stays permissive, `Some(true)`, because the server already narrowed rows |

Comparison of same-typed operands: numbers numerically, text by code point
(rule c), booleans with `false < true`. Postgres orders booleans; JS `<` and
SQLite's 0/1 agree.

### 4. Ordering, NULL ordering and the collation decision

`Subset.comparator` keeps ADR-0026's shape: `orderBy` terms first, then row
id ascending as the tie-break, a genuine total order. Cursor pagination is
unchanged in shape. Three things change inside it.

**Text compares by code point** (rule c). The id tie-break is itself a
code-point comparison; in SQL it is `id COLLATE "C"`.

**NULL ordering follows Postgres's default.** NULL is treated as greater than
every non-null value, so NULLs sort last in `ASC` and first in `DESC`.
Today's `Subset.comparator` sorts `null`/`undefined` first regardless of
direction (`compareValues` in `packages/effect/src/Subset.ts`). This is a
behaviour change. SQLite's default is the opposite (NULL is smallest), so any
SQLite `ORDER BY` pushdown must state `NULLS LAST` or `NULLS FIRST`
explicitly (supported since SQLite 3.30). Absent attributes order as NULL
(rule b).

**Collation decision (deferred here by #156; to confirm in review).** Both
SQL compilers emit an explicit code-point collation on every text comparison
and every text sort term: `COLLATE "C"` on Postgres, `COLLATE BINARY` on
SQLite. _And_ the schema rule stands: filterable and sortable text columns
must be declared `COLLATE "C"` (Postgres) or left at `BINARY` (SQLite). The
compiler cannot tell a text attribute from an instant by the JS literal
alone, so the per-attribute declaration (#154) carries the literal kind
(`text`, `integer`, `double`, `boolean`, `instant`) and the compilers bind
and collate by it (#156). The clause is emitted for `text` attributes only.
An `instant` attribute gets no collation clause: stored as `timestamptz` it
compares chronologically, and stored as `text` it falls under the schema
rule above.

Rationale: exactness by construction is the point of this ADR. If a column
lacks `COLLATE "C"`, the explicit clause keeps results exact and costs index
use on that comparison. That is a performance symptom visible in `EXPLAIN`,
not a correctness symptom visible as a row vanishing after reload. The
documentation-only alternative (declare the rule, emit nothing) was rejected
because nothing checks DDL.

ADR-0026's ruling stands: there is still no observer-local collation, and no
locale-aware or case-insensitive option. A `COLLATE NOCASE` column is
forbidden for filterable or sortable use.

### 5. Placement

| Concern                                         | Owner                                                        |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Filter AST, URL ⇄ AST codec, canonical encoding | effect-jsonapi (thomasfosterau/effect-jsonapi#83, #85, #86)  |
| Per-attribute `filterable` / `sortable`         | effect-jsonapi `Resource` (thomasfosterau/effect-jsonapi#84) |
| `Predicate.evaluate` (JS), `Subset.comparator`  | `@legation/effect` (#155)                                    |
| Postgres and SQLite compilers                   | `@legation/sql` (#156)                                       |
| IndexedDB evaluator and indexes                 | `@legation/browser`, later design (#158)                     |
| Bridge: filter AST ⇄ `Predicate`                | `@legation/jsonapi` (#161)                                   |

`Exists` remains a server-only `Predicate` node. It has no URL form, and the
classifier rejects it for URL and client use; a backend resolves it before
evaluation exactly as today. No dataflow engine is introduced; ADR-0027 §4
stands.

**`null` as a `Predicate` literal.** Today `Predicate.Literal` includes
`null`, and `Predicate.eq(f, null)` means IS NULL: JS `=== null`, and
`Sql.ts` special-cases it to `IS NULL`. Under the grammar NULL is not a
literal. The wire `Literal` union keeps `null` for compatibility, but a
`Compare` or `In` against a null literal evaluates per Postgres (unknown).
The `Predicate.eq(f, null)` and `ne(f, null)` constructors desugar to
`IsNull` and negated `IsNull`, so existing call sites keep their meaning.
The SQL `eq null` special case goes. The wire form with a null literal is
deprecated. `IsNull` and `NotIn` are added to the `Predicate` union and
`PredicateSchema` (wire-additive) by #155.

### 6. Three targets, all first-class

Postgres (the master), SQLite (Cloudflare D1) and IndexedDB (browser). Both
SQL compilers become exact, not superset, once REST handlers derive from
them: the `WHERE` returns precisely the rows `evaluate` returns `Some(true)`
for, and `ORDER BY … COLLATE "C"` with explicit NULL placement returns
precisely `Subset.comparator`'s order. `Subset.apply` still finalises order,
cursor and limit locally where a backend chooses; that is now redundancy,
not correction.

### 7. Testing doctrine

The differential harness (#153) is a dependency of every interpreter change,
not a follow-up. It uses seeded-PRNG generators over rows and predicates, a
real Postgres as the oracle, and SQLite and JS as subjects. It checks
set-equality of row ids per predicate, per-row three-valued equality once
`evaluate` exists, and order agreement against `ORDER BY … COLLATE "C"`.

An interpreter PR must show the harness red before and green after. The
harness runs on SQLite and JS unconditionally, and on Postgres whenever one
is available; in CI it fails loudly rather than skipping silently.
`BackendContract` rule 6 grows a generated corpus so every backend inherits
the check.

## Consequences

- **`Predicate.test` becomes `getOrElse(evaluate, false)`.** Callers keep
  boolean signatures. Rows with NULL or absent fields stop matching `ne`,
  `Not(eq)`, an `In` miss and `NotIn`. An app that relied on `ne` matching
  NULL rows must add an explicit `isnull` disjunct.
- **`CollectionIndex` (`packages/effect/src/CollectionIndex.ts`) changes.**
  It merges its `undefined` and `null` buckets into one; range lookups never
  return that bucket; `isnull` reads it directly; sorted runs use the
  code-point comparator. Its header comment's "no behaviour change" promise
  is replaced by "matches `evaluate`".
- **`Subset.comparator` changes.** Code-point text order and NULLs last on
  `ASC` (first on `DESC`), per section 4. Existing cursor pages over text or
  nullable sort keys may re-order once on upgrade.
- **`Sql.ts` stops claiming "superset".** Its module doc and
  `compileSelect`'s comment are rewritten; both dialects become exact (#156)
  and emit explicit collation and NULL placement.
- **The JSON:API encoder stops dropping operators** (#161), and a parser
  exists for the first time via the effect-jsonapi codec.
- **Existing two-valued assertions on NULL rows move under #155.** Each
  changed assertion cites this ADR; none is deleted. Named:
  `packages/effect/src/__tests__/collection-index.test.ts` ("an absent field
  indexes separately from an explicit null", `eq("a", null)`);
  `packages/effect/src/__tests__/collection-index-property.test.ts` (null and
  absent generation for `a`, `b`, `flag`, and `eq("a", null)` in "matches for
  absent/null fields …");
  `packages/sql/src/__tests__/sql.test.ts` ("handles null equality and empty
  sets without binds").
- **Apps must pin `COLLATE "C"`** on filterable and sortable text columns.
  SQLite `BINARY` already is. A `COLLATE NOCASE` column is forbidden for
  filterable or sortable use.
- **IndexedDB indexes (#158) must key strings as UTF-8 bytes**, because
  IndexedDB's own string order is UTF-16 code-unit order.
- **ADR-0026 is amended in part.** Its Status line and the paragraph
  declaring `Subset.comparator` the sole ordering authority now point here.
  Its body is otherwise untouched.
- **No changeset accompanies this ADR.** Prior ADR-only commits added none;
  the code changes (#155, #156, #161) carry their own.

### Worked NULL example

Three rows in a `tasks` table: `n = { status: null }`, `a = {}` (the
attribute is absent), and a control `c = { status: "open" }`. In SQL the
absent row is a NULL column; `a` only differs from `n` in JS. "Today JS" is
`Predicate.test`; "today SQL" is `compileWhere` run as written; "ADR-0028" is
`evaluate`, and exact SQL agrees with it. `T`/`F`/`U` as in section 3;
"returned" means the row is in the result.

| Predicate                                        | Row | Today JS    | Today SQL   | ADR-0028    |
| ------------------------------------------------ | --- | ----------- | ----------- | ----------- |
| `ne("status", "done")`                           | n   | T, returned | U, excluded | U, excluded |
|                                                  | a   | T, returned | U, excluded | U, excluded |
|                                                  | c   | T, returned | T, returned | T, returned |
| `Not(eq("status", "done"))`                      | n   | T, returned | U, excluded | U, excluded |
|                                                  | a   | T, returned | U, excluded | U, excluded |
|                                                  | c   | T, returned | T, returned | T, returned |
| `In("status", ["open", "done"])`                 | n   | F, excluded | U, excluded | U, excluded |
|                                                  | a   | F, excluded | U, excluded | U, excluded |
|                                                  | c   | T, returned | T, returned | T, returned |
| `NotIn("status", ["done"])` (today: `Not(In)`)   | n   | T, returned | U, excluded | U, excluded |
|                                                  | a   | T, returned | U, excluded | U, excluded |
|                                                  | c   | T, returned | T, returned | T, returned |
| `IsNull("status")` (today: `eq("status", null)`) | n   | T, returned | T, returned | T, returned |
|                                                  | a   | F, excluded | T, returned | T, returned |
|                                                  | c   | F, excluded | F, excluded | F, excluded |

Read down the columns. Today JS returns the NULL and absent rows for `ne`,
`Not(eq)` and `Not(In)`, while SQL excludes them: the divergence #148
found. Today JS also fails to select the absent row with `eq(f, null)`,
while SQL's `IS NULL` selects it. After this ADR every evaluator returns
unknown for those rows and excludes them, and only `isnull` selects them.
`In` already agreed by accident (JS `includes` is false; SQL is unknown);
after this ADR both are unknown, which matters for `Not(In(…))`, where JS
would otherwise flip `false` to `true`.
