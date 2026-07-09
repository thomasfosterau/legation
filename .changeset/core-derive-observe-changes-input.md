---
"@legation/effect": patch
---

`Derive`'s combinators (#114) now consume `observeChanges` directly when a
leaf is built from a full `ClientView` via `Derive.observed`, instead of
diffing consecutive `observe()` pages to recover a delta `LiveView` already
computed (#133 item 1, ADR-0027 §4's flagged follow-up). `Incremental.
deltaFromChanges` reads an `observeChanges` batch's enter/update/exit/move
decision directly; `observed`'s returned source carries this feed invisibly
alongside its ordinary page stream, so `filter`/`map`/`join`/`groupBy`/
`distinct`/`orderedWindow` built on top of it pick it up automatically. A
source built any other way — a raw `Stream`, `view.observe(subset)` called
directly, or another combinator's own output — still diffs pages, unchanged.

No public API changes: `Derive.observed`'s parameter type widens from
`ClientView.Reader` to accept a full `ClientView.ClientView` too, and every
combinator's signature is untouched.
