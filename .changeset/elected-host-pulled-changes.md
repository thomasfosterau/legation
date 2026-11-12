---
"@thomasfosterau/legation-browser": patch
---

The elected host's view forwards `pulledChanges` and `queryRelated` from whichever tier currently serves it, and ticks on every tier switch, so a `Client.observeAnswers` stream over it turns complete once a pull lands (#653).
