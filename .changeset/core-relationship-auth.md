---
"@thomasfosterau/effect-sync-core": minor
---

Relationship-scoped read authorization. Add an `IdentityResolver` seam: an
optional service `(clientGroupId) => Effect<identity>` that `SyncServer` uses to
populate `SyncContext.identity` on every push and pull, so auth filters and
middleware see a real, server-resolved principal (completing the auth-token
story). With identity in hand, relationship-scoped visibility ("an issue is
visible if you're a member of its project") is expressed as an allow-set
predicate: the auth filter resolves the principal's permitted keys and returns
`Predicate.isIn(key, allowed)` over a denormalized key on the row. ADR-0015
documents the pattern and the deferred join-without-denormalization seam.
