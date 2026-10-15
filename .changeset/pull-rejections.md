---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": minor
"@thomasfosterau/legation-jsonapi": minor
---

A pull now carries the permanent rejections its watermark covers, so a client whose push response was lost settles the rejected mutation as rejected, not applied (#365). Before, the pull's watermark acknowledged the rejected id as applied, and its effect was dropped with no way to learn the outcome.

`PullResponse` gains an optional `rejected` list (`{ clientId, mutationId, reason }`), as `PushResponse` already has (#355). The client settles those entries before the watermark acknowledges them. The field is additive: an older client ignores it, and a pull from an older server omits it, so no protocol version changes.

`Backend` gains a required `rejections(context)` method, which lists the group's remembered rejections with their reasons (Backend guarantee 4). A custom backend must implement it before it upgrades. `MemoryBackend`, `SqlBackend` and `JsonApiBackend` already remember their rejections and implement it. `BackendContract` rule 13 checks that the list agrees with the reported outcome.
