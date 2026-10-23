---
"@thomasfosterau/legation-jsonapi": minor
---

The JSON:API façade answers the mutation status URL (ADR-0030 §2, #511):
`GET {prefix}/_legation/mutations/{mutationId}`, the `Location` of every write
receipt, served from the engine's mutation-state map (new option
`mutationStates`) and never forwarded. `200` with one `legation-mutations`
resource (`phase`, `mutator`, `journaledAt`, `settledAt` once settled,
`reason` only when rejected, `links.self` / `links.resource`); `404`
`code: "unknown_mutation"` for an id the map does not hold. `Prefer: wait=N`
holds a pending answer until the mutation settles or `N` seconds pass, capped
by the new `maxWait` option (default 30 s), with `Preference-Applied: wait=N`.
New module `MutationStatus` builds the documents.
