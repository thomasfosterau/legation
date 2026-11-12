---
"@thomasfosterau/legation-browser": patch
---

The elected host's view forwards `pulledChanges` and `queryRelated` from whichever tier currently serves it, and ticks on every tier switch, so a `Client.observe` stream over it is marked complete once a pull lands (#653).
