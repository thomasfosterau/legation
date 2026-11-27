---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-jsonapi": patch
---

`SqlBackend` decodes the mutation ledger's `rejections` column with a schema (a JSON object of mutation id → reason string). A stored value of any other shape, such as a JSON array or a non-string reason, now fails the push with a `BackendError` instead of being read loosely. The column's format is unchanged.

`JsonApiBackend` decodes each member of a write's `relationships` before deriving the hint's linkage. A member that is not a JSON:API relationship object is left out of the linkage, as one without `data` already was, instead of failing with a defect.
