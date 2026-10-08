---
"@thomasfosterau/legation-cloudflare": patch
---

`D1Executor` declares `transactional: false`, so `SqlBackend` keeps the handler-then-bump order on D1 instead of claiming each mutation first. A claim that D1 commits on its own would be skipped by a retry after a crash between the claim and the handler's writes (#359). D1 still does not meet Backend guarantee 1 (#342): a mutation's writes and its ledger bump commit separately, and the README names the transactional alternatives.
