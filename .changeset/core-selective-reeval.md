---
"@thomasfosterau/effect-sync-core": minor
---

Live queries re-evaluate selectively: a change event now names the collections
it touched, so an observer re-runs only when its collection changed, instead of
on every local change. Pulls publish collection-scoped changes when the journal
is empty; overlay-shifting events (a mutation, push, or pull with pending
mutations) still re-evaluate everywhere. A first step toward incremental view
maintenance — full per-row delta maintenance remains a follow-up.
