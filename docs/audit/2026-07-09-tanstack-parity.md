# TanStack parity audit — 2026-07-09

> **Postscript (same day):** the full issue programme this audit filed has
> shipped and been verified — #109–#113 and #115–#119 merged individually;
> #114 (`Derive`/`Incremental` query combinators) closed the headline
> differential-dataflow gap; #108 closed as complete with the model recorded
> in [ADR-0027](../adr/0027-client-local-ivm-delta-model.md) (version-free
> single-timeline `Patch`-op deltas; per-module seams blessed over a shared
> operator core) and [ADR-0026](../adr/0026-subset-ordering-and-collation.md)
> (collation). `docs/comparisons/tanstack.md`'s "expressiveness gap"
> concession is replaced by the two-tier read model. Documented leftovers are
> consolidated in [#133](https://github.com/thomasfosterau/effect-synchronizer/issues/133);
> #120 (devtools panel) remains deliberately deferred. The findings below are
> preserved as written — they describe the pre-programme state.

Audit of the monorepo against **TanStack Query v5** (`@tanstack/query-core` 5.101.x),
**TanStack DB** (`@tanstack/db` 0.6.x + `@tanstack/db-ivm` 0.1.x), and **TanStack
Store** (0.9/0.11), with TanStack Pacer consulted for the write-path timing
primitives. Follows the method of the [Zero parity audit](2026-06-18-zero-feature-parity.md)
and the [2026-07-02 capability gap analysis](2026-07-02-capability-gap-analysis.md)
(whose programme, #33–#50, has fully shipped): the goal is a good story for every
reference use case, natively or via a documented extension point — not API mimicry.
Framework adapters were out of scope; framework-_primitives_ were in scope.

## Headline findings

- **TanStack Query is mostly subsumed by the model.** Freshness clocks,
  invalidation, dedupe, refetch triggers, offline resume, persistence, and
  optimistic rollback are either moot under store-observation + mutation-log
  rebase or already shipped ([`docs/coming-from-tanstack-query.md`](../coming-from-tanstack-query.md)
  documents the mapping). The residual gaps are observability and binding
  ergonomics, not architecture: a keyed reactive mutation-state surface
  ([#116](https://github.com/thomasfosterau/effect-synchronizer/issues/116)),
  React `keepPreviousData` parity — our own Svelte binding is ahead of React here
  ([#118](https://github.com/thomasfosterau/effect-synchronizer/issues/118)),
  and a devtools panel over the #45 substrate
  ([#120](https://github.com/thomasfosterau/effect-synchronizer/issues/120)).
- **TanStack DB's differential-dataflow engine is the real gap**, as
  [`docs/comparisons/tanstack.md`](../comparisons/tanstack.md) already conceded.
  Its `db-ivm` package is a _version-free_ fork of d2ts — single-timeline
  multiset deltas through a static operator DAG (map/filter/join/reduce/
  distinct/topK-with-fractional-index), **not** Naiad-style differential
  dataflow with multidimensional timestamps. That reduced model is a drop-in
  fit for our seq-numbered `ViewChange` hub. Today `LiveView` incrementally
  maintains single subsets (solid), but aggregates refold per emission, joins
  re-group whole collections, **any pending mutation degrades every observer
  to full re-materialization**, predicates always full-scan (no field-value
  indexes), and ordered results are O(n)-copied per change. Filed as an
  umbrella programme with seven staged children:
  [#108](https://github.com/thomasfosterau/effect-synchronizer/issues/108)
  (umbrella + ADR), [#109](https://github.com/thomasfosterau/effect-synchronizer/issues/109)
  overlay deltas, [#110](https://github.com/thomasfosterau/effect-synchronizer/issues/110)
  incremental aggregates, [#111](https://github.com/thomasfosterau/effect-synchronizer/issues/111)
  delta joins, [#112](https://github.com/thomasfosterau/effect-synchronizer/issues/112)
  ordered windows, [#113](https://github.com/thomasfosterau/effect-synchronizer/issues/113)
  field-value indexes, [#114](https://github.com/thomasfosterau/effect-synchronizer/issues/114)
  composable derived queries, [#115](https://github.com/thomasfosterau/effect-synchronizer/issues/115)
  row-level change feed.
- **The expressiveness cap and the auth law are separable.** TanStack DB runs
  arbitrary joins/group-by/`fn.*` predicates client-side and pushes only an
  analyzable predicate subset to the sync layer. We can adopt the same split:
  `Subset`/`Predicate` stay the serializable, auth-narrowable wire vocabulary
  (ADR-0015/0022, untouched); a client-local _derived-view_ tier over observed
  windows supplies distinct/row-group-by/arbitrary joins (#114). Documented as
  a two-tier read model rather than a widened wire language.
- **TanStack Store: correctly absent.** Its role (subscription/derivation
  substrate under Router/Form) is filled by `Atom` from
  `effect/unstable/reactivity`, which `EngineAtoms` already builds on — and
  TanStack DB itself dropped `@tanstack/store` from its core. No action; the
  delegation is the design. Likewise TanStack **Pacer**: the timing primitives
  are Effect's (`Schedule`, `Stream.debounce`, `Queue`); the one genuinely
  missing piece is applying them to journal semantics — paced/coalesced
  mutations ([#117](https://github.com/thomasfosterau/effect-synchronizer/issues/117)).
- **TanStack DB 0.6's persistence round-trip flagged one topology gap**: it
  ships multi-tab leader election; our no-service-worker degraded mode leaves
  election to app code (`examples/svelte-commerce/src/lib/host.ts`). Filed as
  [#119](https://github.com/thomasfosterau/effect-synchronizer/issues/119).

## Where the story is already strong

Confirmed during the audit (no action): query-driven partial sync (queries
compile to sync windows — the native form of TanStack DB 0.5's `loadSubset`
pushdown), durable offline journal with exactly-once application (ahead of
both references), subscription TTL/refcounting, hydration/SSR primitives +
SvelteKit adapter, focus/online/interval sync triggers with backoff,
`mutateWithAck`, undo/redo, aggregations (local tier), typed subsets and
select projections, schema validation (Effect Schema, first-class where
TanStack DB adapts Standard Schema), introspection/telemetry substrate,
service-worker host + mirror multi-tab topology (stronger than
`broadcastQueryClient`), and fallthrough reads for request-shaped data with a
documented stance against a request cache.

## Filed issues

IVM programme: [#108](https://github.com/thomasfosterau/effect-synchronizer/issues/108)
umbrella · [#109](https://github.com/thomasfosterau/effect-synchronizer/issues/109)
overlay deltas · [#110](https://github.com/thomasfosterau/effect-synchronizer/issues/110)
aggregates · [#111](https://github.com/thomasfosterau/effect-synchronizer/issues/111)
joins · [#112](https://github.com/thomasfosterau/effect-synchronizer/issues/112)
ordered windows · [#113](https://github.com/thomasfosterau/effect-synchronizer/issues/113)
indexes · [#114](https://github.com/thomasfosterau/effect-synchronizer/issues/114)
derived queries · [#115](https://github.com/thomasfosterau/effect-synchronizer/issues/115)
change feed.

Write path & lifecycle: [#116](https://github.com/thomasfosterau/effect-synchronizer/issues/116)
mutation-state surface · [#117](https://github.com/thomasfosterau/effect-synchronizer/issues/117)
paced mutations.

Bindings & topology: [#118](https://github.com/thomasfosterau/effect-synchronizer/issues/118)
React keepPreviousData · [#119](https://github.com/thomasfosterau/effect-synchronizer/issues/119)
leader election · [#120](https://github.com/thomasfosterau/effect-synchronizer/issues/120)
devtools panel.

## Deliberately not filed

- **Request-cache features** (staleTime, `refetchOnMount`, per-query
  persisters, `streamedQuery`): moot or against the documented model; the
  coming-from guide covers the translations.
- **Mutation scopes / parallel mutations**: all mutations are serial per
  client by mutation id — that _is_ the sync model (ADR-0008).
- **Immer-style update drafts / direct collection `insert`/`update`/`delete`**:
  writes are named intents by design; the local-only-mutator pattern covers
  the escape hatch.
- **A TanStack Store equivalent and a Pacer utility module**: delegated to
  Effect (`Atom`, `Schedule`/`Stream`/`Queue`).
- **Structural sharing beyond row-level stability**: patches are row-level
  already; page arrays are reference-stable when unchanged and rows keep
  identity through changes — the remaining delta to TanStack's
  `replaceEqualDeep` has no observed consumer.
- **React SSR meta-framework adapter**: the primitives (`Hydration.snapshot`,
  seed, `hydrateIfEmpty`) are framework-agnostic and proven via
  `@legation/sveltekit`; an adapter is thin app-shaped work.
