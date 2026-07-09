---
"@legation/effect": minor
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
page transitions.

Move events (stable position keys across a maintained order) are out of
scope until #112 lands; a consumer that needs ordering re-derives it from a
paired `observe()` or the position of `enter`s within a batch. See
`docs/observing-row-changes.md` for the framework-binding guide (a Svelte 5
keyed-list example) and the `runOnChanges`-style side-effect pattern.
