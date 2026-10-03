---
"@thomasfosterau/legation-effect": minor
---

`LiveView` (the incrementally-maintained live-query result behind paginated
queries) no longer rebuilds its ordered set as a copied array on every change
(issue #112). The maintained order and its id index are now persistent
weight-balanced trees (`OrderedTree`, a new internal module): `put`/`del` cost
O(log n) instead of O(n), and reslicing a window is O(log n + window) — a
100k-row maintained set with steady single-row churn no longer pays for a
full array copy on every unrelated-row update (see the new
`live-view-churn.bench.ts`).

In-window rows now carry a stable `FractionalIndex` `position`:
assigned when a row enters the window, dropped when it leaves, and left
untouched when the row didn't move relative to its neighbors — the primitive
a future row-level delta feed needs to express a reorder as a move instead of
a page diff. `LiveView.retarget` widens a `limit` or advances a `cursor` over
the _same_ maintained order, with no re-materialization — the pure half of
the "load more widens one window" story (`useConnection`, ADR-0024); wiring
this into an open `ClientEngine` subscription so the client never
re-registers on "load more" is flagged as future work in `LiveView.ts`.

`Subset.comparator` now tie-breaks on row id, making it a genuine total order
even with an empty `orderBy` (previously every row tied, and `LiveView`'s
delta-location degraded to a full scan). Because every backend
(`MemoryBackend`, `@thomasfosterau/legation-sql`'s `SqlBackend`,
`@thomasfosterau/legation-jsonapi`'s `JsonApiBackend`) already finalizes order/limit/cursor
locally via `Subset.apply`, this same comparator is the sole ordering
authority for both client and server — a subset with no declared `orderBy`
now sorts by id ascending everywhere instead of an unspecified order. The
collation decision (why this rules out a client-local collation option, and
what a real one would require) is recorded in
`docs/adr/0026-subset-ordering-and-collation.md`.
