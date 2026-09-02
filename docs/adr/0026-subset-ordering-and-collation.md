# ADR-0026: Subset ordering is a shared total order; collation is a documented punt

Date: 2026-07-09
Status: Accepted (issue #112). Superseded in part by ADR-0028 (evaluation authority and collation)

## Context

Issue #112 asked for `LiveView` to maintain its ordered window
incrementally — O(log n) structure, stable position keys, cheap window
widening — and, along the way, to settle a question the implementation
forced: **what is "the order" a maintained set is sorted by, exactly, and
who gets to define it?**

Two things were already true and turned out to answer this together:

- `Subset.apply` (filter → sort → cursor → limit) is **the** reference
  evaluation semantics. Every backend (`MemoryBackend`, `@legation/sql`'s
  `SqlBackend`, `@legation/jsonapi`'s `JsonApiBackend`) pushes down only
  the predicate; order, cursor, and limit are always finalized locally with
  `Subset.apply` (`Sql.ts`: "the `WHERE` only has to return a superset").
  So the server's cursor pages are already defined by this one function,
  not by whatever order a SQL `ORDER BY` or a `Map`'s iteration happens to
  produce.
- `LiveView` (the client's maintained order) built its result by calling
  `Subset.sortFiltered` once and then keeping it incrementally sorted by
  `Subset.comparator`. If that comparator ever diverged from what
  `Subset.apply` does from scratch, the client's maintained order and the
  server's authoritative cursor windows would tear — a row could appear on
  one client page and be silently skipped on the next pull, or duplicated.

That makes `Subset.comparator` a **single, shared ordering authority**
for both tiers by construction — not a designed protocol, just a fact
that fell out of `Subset.apply` already being the one evaluation path
everywhere. Two gaps followed from taking that seriously:

1. **No orderBy still needs a total order.** An empty `orderBy` made
   every row tie under the old comparator; `LiveView`'s delta-location
   (`indexOf`) degraded to a full scan over the tied run, and
   `Subset.sortFiltered` skipped sorting entirely (returning rows in
   whatever order the caller handed them — a `Map`'s iteration order for
   `MemoryBackend`, undefined order for a `SELECT` with no `ORDER BY`).
   Cursor pagination over an _undefined_ order is not well-defined at
   all: "the row after this cursor" presumes a fixed order to be after
   _in_.
2. **Collation is currently JS's default `<`.** String comparison is
   code-unit order, not locale-aware; there is no case-insensitive or
   accent-insensitive option. TanStack DB (the reference this issue's
   parent, #108, is modeled on) exposes `compare`/`compareOptions` per
   observer. We cannot do that here **unchanged**: an observer-local
   collation would let a client sort `"café"` before `"cafe"` while the
   server's cursor windows assume code-unit order, silently tearing pages
   the moment collation-sensitive fields are involved.

## Decision

**`Subset.comparator(orderBy)` is the sole ordering authority, and it now
tie-breaks on row id.** Concretely: value fields compare first (as
before), then — if every field ties, including the empty-`orderBy` case
— row id compares ascending. This makes the comparator a genuine total
order unconditionally:

> **Superseded in part by ADR-0028.** `Subset.comparator` and `Subset.apply`
> are no longer the definition of correctness; Postgres semantics are, and
> both are implementations that must agree with Postgres exactly. ADR-0028
> also settles the collation punt below (code-point order, `COLLATE "C"`)
> and changes NULL ordering to NULLs last on `ASC`. The id tie-break and the
> total-order guarantee in this section stand.

- `LiveView`'s incrementally maintained order (an `OrderedTree`, see the
  module) can locate any row's position in O(log n) always, not "O(log n)
  for distinct keys, O(n) for an empty `orderBy`."
- `Subset.sortFiltered` always sorts (the empty-`orderBy` fast path that
  skipped sorting is gone), so "no orderBy" now means a specific,
  deterministic order (id ascending) instead of an unspecified one — the
  same order on every backend, because every backend routes through this
  one function.
- Cursor pagination is well-defined even with no declared `orderBy`: "the
  row after this cursor" now means something concrete.

This is additive to every existing caller: `Subset.apply` (and therefore
every backend's `evaluate`) already routed order/limit/cursor through
`sortFiltered`/`comparator`; nothing outside `Subset.ts`/`LiveView.ts`
constructed its own order.

**Collation stays JS default `<`, punted deliberately, not silently.**
We do not add a client-local collation option — that was the one thing
this issue explicitly ruled out, since it is exactly the failure mode
above (client and server disagreeing on order). We also do not add a
declared, serialized collation to `Subset`/the collection schema in this
change: nothing in the codebase needs non-default collation yet, and
adding the field speculatively would be exactly the kind of
unrequested-abstraction CLAUDE.md asks us not to build. Instead, the
constraint and the future shape of the fix are recorded as a comment on
`Subset.comparator` (the one place both tiers actually call): a
collation, if ever needed, is a new optional field on the serializable
`Subset` (or the collection/Node definition) — the same shape as the
derivable-set declaration (ADR-0023) — threaded into this one comparator
on both sides. Additive, not a breaking change, when it lands.

## Consequences

- `LiveView`'s per-delta cost is O(log n + window) unconditionally, with
  no orderBy-shaped escape hatch to a full scan (issue #112's acceptance
  criterion).
- A subset with no declared `orderBy` now has a specific, stable order
  (id ascending) instead of an implementation-defined one. Any test or
  backend that happened to depend on the previous "unsorted" behavior
  would see a behavior change; auditing the in-repo backends
  (`MemoryBackend`, `SqlBackend`, `JsonApiBackend`) and their test suites
  found none — order was never asserted for an orderBy-less subset
  because it was never guaranteed.
- Locale-aware / case-insensitive collation remains unimplemented. A
  collection sorting user-facing text (names, titles) by default code-unit
  order will keep doing so until a declared collation field is added; this
  is a known, tracked gap, not a silent one.
- The comparator is still a pure function of `(orderBy, row)` — no new
  dependency, no schema change, no wire format change.
