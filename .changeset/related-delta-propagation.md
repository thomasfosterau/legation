---
"@thomasfosterau/legation-effect": minor
---

`Related.observeWith` now propagates row deltas through the join instead of
re-grouping whole collections (issue #111, part of the #108 IVM umbrella): a
foreign-row change updates only the one or two `fk → rows` buckets its old and
new key select and re-hydrates only the base rows keyed to those buckets,
instead of rebuilding the collection's whole group index and re-hydrating the
full base page. A base-row change re-hydrates only that row. A linkage shift
(which foreign collections are targeted) diffs the targeted set against the
previous one — the same diff-and-release shape `reconcile` already uses for
subscriptions — and starts/stops only the newly (un)targeted collections'
observers, instead of tearing every observer down and re-priming from scratch.
The public API (`related`/`observeWith`/`relatedWith`) and ADR-0024
auto-subscription reconciliation are unchanged. The new `Related.makeJoinEngine`
is the pure, Effect-free incremental engine behind this, exported so its
equivalence to a from-scratch hydrate (`Related.hydrateFromScratch`) can be
property-tested directly.
