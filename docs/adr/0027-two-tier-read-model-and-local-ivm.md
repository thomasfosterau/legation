# ADR-0027: The two-tier read model — a serializable sync tier and a client-local IVM/derived tier

Date: 2026-07-09
Status: Accepted (issues #108, #114)

## Context

Two long-running threads converge here.

**#108 (the differential-dataflow IVM umbrella)** set out to close the
expressiveness gap `docs/comparisons/tanstack.md` concedes: TanStack DB
compiles every live query — joins, group-by, distinct, order-by+limit — to a
version-free operator graph of `map / filter / join / reduce / distinct /
topKWithFractionalIndex` over multisets of `[value, ±multiplicity]` deltas,
maintained incrementally, and **every live query result is itself a
collection**, so queries compose from queries. #108's plan had three parts:
write the model/boundaries ADR, build a self-contained operator core, and land
the consumers incrementally.

The consumers all landed as **targeted per-module changes** rather than over
one shared core (#109 delta-maintained overlay, #110 incremental aggregates,
#111 delta-propagating `Related` joins, #112 the ordered-window `OrderedTree`
with fractional-index positions, #113 secondary field indexes). Along the way
one slice of the ADR — the collation/ordering-authority question — was settled
as **ADR-0026**. What remained unwritten was the _model and boundaries_ ADR
itself, and the two remaining consumers: the public change feed (#115) and the
composable derived-query tier (#114).

**#114 (composable derived live queries)** is the public face of that operator
machinery: the client-local relational shaping — arbitrary (non-edge) joins,
DISTINCT, row-level GROUP BY, computed/cross-field predicates, LIKE/prefix
matching — that the audit listed as _not expressible_ in our read layer. It is
not expressible **on the wire** by design, and that is the crux this ADR
exists to state precisely.

### The law this must not break (ADR-0015, ADR-0022)

`Subset`/`Predicate` are the **serializable, auth-narrowable** wire vocabulary.
A client subscription is `(collection, predicate, order, limit/cursor)`; the
server AND-s a mandatory auth filter into every subscription before evaluating
it (deny by default); one foreign key powers the join, the sync window, the
auth scope, and the fan-out topic (ADR-0022's edge identity). The wire language
is therefore capped at **what a server auth filter can safely reason about** —
a flat, analyzable subset. Widening it to carry arbitrary JS predicates or
cross-collection joins would break auth-narrowing and fan-out derivation at
once. That cap is not a limitation to be lifted; it is load-bearing.

TanStack DB shows these two concerns can be _split_ instead of _capped
together_: its query builder (arbitrary `fn.where`/`fn.select` callbacks,
sub-queries, joins) runs **entirely client-side** over already-synced
collections, and only a narrow, analyzable predicate is pushed down to the sync
layer. We already have the pushdown half natively — a `Query` compiles to a
plan of sync windows (ADR-0022/0024). What was missing was the tier _above_
materialization.

## Decision

### 1. The read layer is two tiers, and the boundary between them is a rule

- **The sync tier** is serializable and auth-narrowable: `Query` → `Subset` /
  `Predicate` → sync windows / CVRs / fan-out topics. **This tier alone decides
  what the server ships to a client.** It is the correctness boundary, the auth
  boundary, and the wire.

- **The derived tier** is client-local read machinery _behind `observe`_: it
  shapes, relates, and rolls up **only the rows a client has already synced**.
  It is never serialized, never sent to a server, never an auth unit, and never
  a sync window.

**The boundary rule — the derived tier never widens what syncs.** A derived
combinator sees only what its source streams already hold. The failure mode
this forbids, stated plainly so it cannot be stumbled into: _filtering locally
and believing the result set is complete._ `Derive.filter((t) => t.urgent)`
over a page synced as "my open todos" shows the urgent todos **among those
already synced** — never any the sync window excluded. If a derived view needs
rows the client does not hold, the fix is to widen the `Query` (what syncs),
never the combinator (what is shown). This is the exact analogue of the rule
already documented for `Aggregate` ("local tier only: it sees the rows this
client has synced") and for the HTTP-cache tag ceiling in CONTEXT.md.

### 2. Incremental view maintenance is internal, version-free, and multiset-shaped

The maintenance model is db-ivm's, not d2ts's: a **single timeline**, no Naiad
timestamps, no frontiers, no `iterate`. The engine's change hub already carries
seq-numbered row deltas (`ViewChange.Patch` put/del ops) — exactly the multiset
input an operator graph wants — so the full version/frontier machinery buys us
nothing. Each operator consumes row deltas (`added`/`removed`) and emits the
delta to its result; a change touches only the rows it affects, never a refold
of the whole input. A refolding version of the derived tier was explicitly
judged **not worth shipping** (#114 brief): the incremental maintenance _is_ the
feature.

### 3. The operator core is `Incremental`; the public face is the `Derive` combinators

`@legation/effect/internal`'s **`Incremental`** module is the small operator
core #108 called for, now extracted from the proven per-module machinery rather
than invented ahead of it: pure, Effect-free `map / filter / distinct / join
(inner+left) / groupBy(rows) / orderedWindow` engines plus from-scratch
references. It reuses what the #108 children built — `orderedWindow` maintains a
`LiveView`/`OrderedTree` (ADR-0026's one ordering authority applies, so "no
orderBy" still means a stable id order); `join` follows `Related.makeJoinEngine`'s
"re-derive only the affected rows" discipline; `groupBy` follows `Aggregate`'s
"touch only the affected bucket" discipline.

**`Derive`** is the public tier #114 specifies: **bare, composable combinators**
(no new domain noun, no fluent builder facade) over any source satisfying the
`ClientView.observe` shape — an owned engine, a mirror, _or the output of
another combinator_. Because every combinator's input and output are page
streams of the same `(id, value)` rows, **queries-from-queries falls straight
out of the shared shape** — the same seam `LiveQuery` and `Related` already
play. Results are an Effect `Stream` and, via `Derive.atom`, an Atom on the
standard reactivity surface, so framework bindings need nothing new. Leaf
subscriptions compose through the refcounted `Subscriptions` manager and release
on scope close, so a pipeline tears its whole chain down together.

Until #115's row-level `observeChanges` feed lands, the derived tier consumes
page snapshots and recovers deltas by diffing consecutive pages at the source
boundary (`Incremental.diff`); when #115 lands, its deltas feed the operators
directly and the diff step drops away.

## Non-goals

- **No wire, `Subset`, or `Predicate` change.** The derived tier is entirely
  behind `observe`. Nothing here becomes serializable or auth-relevant.
- **No Naiad timestamps / frontiers / iteration.** Version-free, single
  timeline (see decision 2).
- **No query-language change and no fluent builder facade.** The derived tier is
  a set of functions in the existing read vocabulary; a builder over them is
  revisited, if ever, only once the combinators exist (#114 out-of-scope).
- **No nested `include` depth or per-edge cursors** (ADR-0024 territory), and no
  full-text search.
- **No literal "one operator DAG" rewrite of the existing consumers.** The #108
  children shipped API-compatible per-module; `Incremental` is the shared
  substance extracted for the _new_ derived tier, not a forced re-plumbing of
  `LiveView`/`Related`/`Aggregate`.

## Consequences

- The "expressiveness gap" concession in `docs/comparisons/tanstack.md` is
  replaced by a two-tier story: the sync tier is deliberately narrow (so it
  stays serializable and auth-analyzable); the derived tier is where arbitrary
  relational shaping lives, client-side, over already-synced data.
- CONTEXT.md gains **no new noun**: derived live queries are still _live
  queries_ (the glossary's read-concept entries get at most a qualifier
  sentence pointing at the combinators). "Derived view" is descriptive prose,
  not a domain term.
- A whole class of app code — the hand-rolled joins/group-bys the Northwind and
  RealWorld examples wrote over emitted pages — collapses to combinator
  pipelines that are incrementally maintained instead of refolded per render.
- #115 (`observeChanges`) remains the one open #108 consumer; it is the delta
  feed this tier will consume directly, and #112 left `LiveView` position hooks
  for it. The umbrella's remaining substance after this ADR is #115 alone.
- The never-widens-sync rule is now stated in one authoritative place (here),
  and echoed in the `Incremental`/`Derive` module docs and the migration guide —
  so the one dangerous mistake this design forbids has a name and a home.
