---
"@thomasfosterau/legation-jsonapi": patch
---

`JsonApiBackend` no longer emits a stale value in a push's change hint for a row that a later mutation of the same push deleted. A create or update in an earlier mutation left its value in the batch's hint values after a later mutation deleted the row, on both the per-resource and the atomic-operations paths, so the hint carried a row that no longer exists. The delete now removes the row from the batch's values, as a delete within one push already does in the other backends.
