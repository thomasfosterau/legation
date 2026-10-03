---
"@thomasfosterau/legation-cloudflare": patch
---

`makeRoomClass` now declares its return type explicitly (a constructor producing `state`, `env`, `fetch`, `webSocketMessage` and `webSocketClose`) instead of leaking the anonymous class's `#private` members into the emitted declaration, which TypeScript 6 and 7 reject.
