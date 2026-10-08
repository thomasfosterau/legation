---
"@thomasfosterau/legation-effect": patch
---

`MemoryBackend` now reports the committed outcome from every copy of a mutation. A copy that loses a race to another copy, or replays a mutation already committed, lists it in `rejected` when it was committed as permanently rejected, with the same reason. Before, such a copy reported nothing, so a client could settle a rejected mutation as applied, or show its optimistic effects until the next pull, depending on which push response arrived first. A committed rejection is remembered until the client's next push starts past it, so the backend holds at most that push's unacknowledged rejections per client.
