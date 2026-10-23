---
"@thomasfosterau/legation-jsonapi": minor
---

The JSON:API façade answers a write it cannot journal offline with ADR-0030
§3's error documents (#512): `400 invalid_document`, `409 type_mismatch` /
`id_mismatch` and `422 unsupported_relationship` for a malformed or mismatched
body, each with `source.pointer`; the `503` `offline` document with a second
error `client_id_required` (`source.pointer: "/data/id"`) for a create without
a client id, or `not_journalable` (the `MutatorError`'s message) for a
mutation the engine refuses; the plain `503` `offline` document for
`Prefer: handling=strict`. Online, the same requests are forwarded untouched.
Attribute values are never validated by the façade.
