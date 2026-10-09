---
"@thomasfosterau/legation-effect": patch
---

The in-memory `ClientStore` now takes the atomic batch path that the key-value store takes when it has an `AtomicKeyValue`: a pull's release and a push acknowledgement's park and trim each run as one step under the store's lock, with no release record. A release the store refuses now writes nothing, so the unpulled tail keeps its entries and can sit above its bound until the next push acknowledgement or pull releases them, rather than being finished from a record.
