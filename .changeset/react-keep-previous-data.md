---
"@legation/react": minor
---

`useQuery`/`useNamedQuery` accept an options object: `keepPrevious` keeps the previous subset's rows on screen as a `waiting` `Success` while a changed subset (a paging cursor, a filter) loads, instead of dropping to `Initial` — this binding's equivalent of TanStack's `placeholderData: keepPreviousData`, matching the Svelte binding's resubscribe semantics (`useLiveStream`). `initial` seeds the hook's first render with a synchronous `Success` before the live query has emitted (e.g. server-fetched or prefetched rows), matching the Svelte binding's `initial` for API symmetry across bindings.

The consumer discriminates previous ("stale") from fresh data via `AsyncResult.isWaiting`: a live-query atom's `Success` now settles to `waiting: false` once its own subset has emitted (previously always `waiting: true`, an artifact of the underlying stream atom's construction), so `waiting` reliably means "this is carried-over previous data" rather than "this is a live subscription".
