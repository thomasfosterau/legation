---
"@thomasfosterau/legation-effect": patch
---

`MemoryBackend` no longer emits a stale value in a push's change hint for a row
that a later mutation of the same push deleted. A put in an earlier mutation
left its value in the batch's hint values after a later mutation deleted the
row, so the hint carried a row that no longer exists and fine-grained fan-out
routed by it. The delete now removes the row from the batch's values, as a
delete within one mutation already did.
