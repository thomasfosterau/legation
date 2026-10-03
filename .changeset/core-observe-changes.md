---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": patch
---

Add `observeChanges(subset, options?)`: a public row-level change feed
(`RowChange`, #115) on `ClientEngine`, `ClientView`, and `Mirror` alike
(ADR-0021), for keyed-list bindings, side-effect subscriptions, and delta
pipelines that today have to diff `observe()`'s pages by hand. Batched per
view-step:

- `enter`/`exit` are anchored to the subset's windowed result — a predicate
  or limit-boundary crossing (an insert pushing the last visible row out, a
  delete pulling the next one in) produces the pair a consumer diffing two
  pages would derive; `update` marks a same-membership value change.
- A `Rebuild` (the optimistic overlay shifted) or a seq-gap collapse (a
  bounded change hub dropped one or more changes) emits a `reset` marker
  followed by fresh `enter`s for the current window, rather than a diff
  against unknown prior state.
- `{ includeInitial: true }` emits the current window as `enter`s in the
  first batch, with the same subscribe-before-snapshot guard `observe`
  already uses (#84) — a late subscriber sees exactly one batch, no gap or
  duplicate row.

`ClientEngine` derives batches from the same incrementally-maintained
`LiveView` window `observe` already keeps (surfaced, not recomputed);
`Mirror` — which has no local `LiveView` — diffs the whole-page updates its
host already broadcasts, so both hosts emit identical batches for identical
page transitions. `@thomasfosterau/legation-browser`'s `ElectedHost` switches an observer
onto whichever `ClientView` (mirror or owned engine) is currently active, so
`observeChanges` works unchanged across a leader-election transition too.

A confirmed-row pull and a plain local mutation (#109's delta-maintained
overlay tracks a mutator's local handler directly and publishes exactly what
it did) both diff precisely; `Rebuild` is reserved for cases the overlay
genuinely can't diff — a pull racing a still-pending mutation, an unknown
mutator, a reset (`Clear`) patch — or a seq-gap collapse.

Move events are not yet part of the contract: `LiveView` rows carry a stable
position (#112) at runtime, but a row repositioned by a neighbor's
insert/delete without its own value changing isn't distinguished from
"unchanged" here — a consumer that needs order re-derives it from a paired
`observe()` or the position of `enter`s within a batch, pending that
follow-up. See `docs/observing-row-changes.md` for the framework-binding
guide (a Svelte 5 keyed-list example) and the `runOnChanges`-style
side-effect pattern.
