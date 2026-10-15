---
"@thomasfosterau/legation-effect": minor
---

A push never takes the acknowledged-but-unpulled tail past its bound, and no overlay entry is released early. A push that carries more than half the bound goes out in chunks of half the bound, with a pull before each chunk after the first, and each chunk takes only the room the tail leaves. Overlapping pushes share that room, so the bound holds across them. A push whose tail has no room pulls first, and fails if that pull fails or releases no room. The cost is extra round trips for a large flush, and a push that waits on the pulls between chunks. A pull between chunks that fails or is refused fails the push with a transient `TransportError`, and so does a chunk that fails; the unsent mutations stay journaled for the next push.

This removes the overflow release, so the optional `ClientStore.commitTailRelease` member and its release-record path are gone. Pulls still release the tail through `releaseUnpulled` and the pull's release record. The member is optional, so a custom `ClientStore` that sets it needs no change, but code that calls `store.commitTailRelease` no longer compiles. That is a breaking change for the interface, so this is a minor bump before 1.0.
