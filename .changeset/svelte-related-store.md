---
"@thomasfosterau/legation-svelte": minor
---

Add a `related` store: a live join over a subset's declared relationships
(`Related.observe` bridged to a Svelte `Readable`), replacing the hand-rolled
`relatedStore` pattern in the Svelte examples. The base and foreign
collections must already be subscribed — the store reads the mirror.
