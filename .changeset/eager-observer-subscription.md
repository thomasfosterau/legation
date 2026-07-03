---
"@legation/effect": patch
---

Observers subscribe to their change hub BEFORE taking the initial
snapshot (#84). A hub only delivers to live subscribers, so a change
published while an observer materialized its first page was silently
lost — and because seq-gap recovery needs a _next_ item to notice the
gap, a quiet collection never re-emitted: `Related` joins missed foreign
writes, live queries slept through a mutation that landed in the
subscribe window. `ClientEngine`'s subset observers and `TabMirror`'s
key observers now hold the subscription first; a buffered change the
snapshot already reflects steps as a stale seq or an idempotent
re-apply.
