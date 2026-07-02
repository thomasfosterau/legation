# Capability gap analysis — 2026-07-02

Audit of the monorepo (commit `cbb31a0`) against the reference capability set:
**TanStack Query v5** and **SwiftData `@Query`/`ModelActor`** (primary); SWR, RTK
Query, Apollo/urql/Relay, and the local-first engines (Zero, ElectricSQL,
Replicache, LiveStore, RxDB, TanStack DB) (secondary). The goal, as with the
[Zero parity audit](2026-06-18-zero-feature-parity.md): a good story for every
reference use case, natively or via a documented extension point.

The full inventory, classification table, out-of-scope list, and label
proposal live in the tracking issue:
**[#51 — Capability gap analysis: SwiftData / TanStack Query / sync-engine parity](https://github.com/thomasfosterau/effect-synchronizer/issues/51)**.

## Headline findings

- **Supported by design, undocumented.** A large slice of TanStack Query's
  surface (staleTime/invalidation/dedupe/setQueryData/optimistic rollback) is
  moot or structurally subsumed under store observation + mutation-log rebase;
  the same holds for SwiftData's `@Query` auto-invalidation, `ModelActor`
  serialisation, and Apollo-style normalisation (collections _are_ the
  normalised store). The mapping is a documentation gap, filed as
  [#50](https://github.com/thomasfosterau/effect-synchronizer/issues/50).
- **The sync loop is the biggest functional gap.** Nothing schedules a push
  after `mutate`, there is no interval/focus/online trigger wiring, the RPC
  transport hard-codes `"connected"`, and no retry policy exists anywhere
  ([#33](https://github.com/thomasfosterau/effect-synchronizer/issues/33),
  [#34](https://github.com/thomasfosterau/effect-synchronizer/issues/34)).
- **A permanently rejected mutation wedges the client** (journal never trims,
  overlay never drops) — the one place the engine is behind Replicache's
  documented contract
  ([#35](https://github.com/thomasfosterau/effect-synchronizer/issues/35),
  with the outcome surface in
  [#36](https://github.com/thomasfosterau/effect-synchronizer/issues/36)).
- **The read surface is untyped** despite schema-carrying collections — every
  example casts `row.value as T`
  ([#37](https://github.com/thomasfosterau/effect-synchronizer/issues/37)).

## Filed issues

Sync loop & delivery: [#33](https://github.com/thomasfosterau/effect-synchronizer/issues/33)
scheduling · [#34](https://github.com/thomasfosterau/effect-synchronizer/issues/34)
retry/backoff · [#35](https://github.com/thomasfosterau/effect-synchronizer/issues/35)
poison mutations · [#36](https://github.com/thomasfosterau/effect-synchronizer/issues/36)
mutation outcomes.

Query surface: [#37](https://github.com/thomasfosterau/effect-synchronizer/issues/37)
typed queries/select · [#38](https://github.com/thomasfosterau/effect-synchronizer/issues/38)
core relationships · [#39](https://github.com/thomasfosterau/effect-synchronizer/issues/39)
write-path IVM + indexes · [#40](https://github.com/thomasfosterau/effect-synchronizer/issues/40)
aggregations.

Data lifecycle: [#41](https://github.com/thomasfosterau/effect-synchronizer/issues/41)
seeding/prefetch/SSR hydration · [#46](https://github.com/thomasfosterau/effect-synchronizer/issues/46)
undo/redo · [#47](https://github.com/thomasfosterau/effect-synchronizer/issues/47)
per-row persistence + journal bounds · [#48](https://github.com/thomasfosterau/effect-synchronizer/issues/48)
schema-version negotiation.

Server & fan-out: [#42](https://github.com/thomasfosterau/effect-synchronizer/issues/42)
predicate-aware fan-out · [#43](https://github.com/thomasfosterau/effect-synchronizer/issues/43)
CDC for out-of-band writers (discussion) · [#44](https://github.com/thomasfosterau/effect-synchronizer/issues/44)
backpressure.

Observability & docs: [#45](https://github.com/thomasfosterau/effect-synchronizer/issues/45)
introspection/devtools substrate · [#49](https://github.com/thomasfosterau/effect-synchronizer/issues/49)
HTTP-cache tag invalidation wiring · [#50](https://github.com/thomasfosterau/effect-synchronizer/issues/50)
vocabulary mapping docs.

## Existing-issue reconciliation

Pre-v2-rebuild issues #12, #14, #17, #18 and umbrella #19 reference files and
architecture that no longer exist; #51 recommends closures/supersessions
item by item.
