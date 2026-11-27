---
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

Document that `RoomTransport`'s `status` reports the HTTP tier only and stays `"connected"` while the poke socket reconnects: pokes are hints, and the pull interval recovers any a dead socket misses.
