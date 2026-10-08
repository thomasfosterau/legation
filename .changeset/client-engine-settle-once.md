---
"@thomasfosterau/legation-effect": patch
---

`ClientEngine` settles each mutation once. A push response that repeats a
permanent rejection the client already holds (the response of a copy that
loses a race, #355) no longer emits a second `MutationRejected` event or
resolves a `mutateWithAck` handle twice. A rejection reported for a mutation
the client has already acknowledged no longer overwrites its `acknowledged`
state. The first committed outcome the client observed stands: a later,
contradictory report is logged at debug and ignored.
