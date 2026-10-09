---
"@thomasfosterau/legation-sql": patch
---

`SqlBackend` on an executor without transactions forgets a rejection that an earlier push recorded before its bump failed, once a retry applies the same mutation. Before, the stale rejection outlived the retry, so every later replay reported a rejection for a mutation that had applied (#425).
