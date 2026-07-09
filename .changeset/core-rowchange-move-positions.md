---
"@legation/effect": minor
---

`RowChange` (#115) gains `move` and a `position` field on `enter`/`update`
(#133 item 2, #112's follow-through): `LiveView`'s stable fractional-index
position, present whenever the source can compute one. A row whose value is
unchanged but whose neighbors shifted enough to move it — a sibling
entering/leaving the window re-ranks it — now emits `move` (`position` +
`previousPosition`) instead of being silently dropped as "unchanged," so a
keyed-list consumer can place `enter`s and re-sort on `move` rather than
only appending.

`ClientEngine.observeChanges` (backed by `LiveView`'s incrementally-
maintained window) emits `position`/`move`; `Mirror.observeChanges` does
not — a mirror has no maintained window of its own, only whole-page
broadcasts to diff, so it can't derive a stable position from a snapshot
alone. Documented, not silent (`docs/observing-row-changes.md`), which also
gains an updated Svelte 5 keyed-list example ordering by `position`.

Purely additive: existing `enter`/`update`/`exit`/`reset` consumers that
don't read `position` are unaffected.
