---
"@thomasfosterau/legation-effect": patch
"@thomasfosterau/legation-browser": patch
---

`Hydration.dehydrate` now reads the store as one state. It used to read the
confirmed rows, the cookie, the journal and the unpulled tail in four separate
calls, so a pull or a push acknowledgement that landed between them could leave
a snapshot whose rows lacked an acknowledged mutation's effect, while that
mutation sat in neither the journal nor the tail. `ClientStore` gains an
optional `snapshot` member that reads all four together: under the store's lock
for the memory and key-value stores, and in one read transaction on IndexedDB.
`dehydrate` uses it when the store offers it and reads member by member
otherwise, so a third-party store behaves as before.

The `AtomicKeyValue` seam on `@thomasfosterau/legation-effect/internal` gains an
optional `readAll`, which the browser's IndexedDB binding supplies as one
`readonly` transaction over the entries store. A key-value store with that seam
decodes its snapshot from that single read.
