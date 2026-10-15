---
"@thomasfosterau/legation-effect": patch
---

A push that carries more than half the unpulled bound now goes out in chunks of
half the bound, with a pull between them, so one oversized push (a long offline
journal flushed at once) no longer takes the acknowledged tail past the bound
and releases overlay effects early on a healthy transport. The cost is extra
round trips for a large flush, and a push that waits on those pulls. A chunk
that fails, or a pull between chunks that fails, ends the push; the unsent
mutations stay journaled for the next one.
