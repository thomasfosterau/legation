---
"@thomasfosterau/legation-effect": minor
---

Add `server.mutate` (ADR-0030, amendment #215): run one named Mutation
server-side as one of a client group's mutations, the entry point a form
action calls. It takes the client group, a form client id with its mutation id
(`1` for a freshly rendered form), the Mutation and its decoded args, and takes
the push path minus the transport: identity is resolved through the
`IdentityResolver`, the middleware's `onPush` runs, the backend applies the
mutation with its id bumped in the same transaction as its effects, and the
write is broadcast. It answers a `Server.Receipt`,
`{ clientId, mutationId, phase, reason? }`, with `phase` `acknowledged` or
`rejected` with the backend's reason. A resubmission of the same
`(clientId, mutationId)` is skipped by the ledger and answers the original
ruling. Args that do not encode against the Mutation's schema are a defect of
the form layer's hand-over, not a field error.
