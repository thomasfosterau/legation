---
"@thomasfosterau/legation-jsonapi": minor
---

Add convention-first sync derivation from an app's JSON:API `HttpApi`
(`JsonApiSync`). Point it at an Effect `HttpApi` and it reflects the endpoints,
classifies them by method + path into JSON:API CRUD roles (`Convention`),
derives one collection and the create/update/delete mutators per resource type
(`Derive`), and backs the BYO `Backend` contract with HTTP calls
(`JsonApiBackend`) — content-hash row versions stand in for the version token a
plain REST API doesn't expose. `JsonApiSync.layer` composes the whole
client-direct stack (in-process sync room + client engine) so an existing REST
API gains optimistic writes, a durable journal, rebase, and live queries with
no bespoke backend; `JsonApiSync.start` runs the sync loop and polls for remote
changes.

Delivery is at-least-once (the in-session ledger has no cooperating server), so
keep writes idempotent: client-generated ids on create, naturally-idempotent
PATCH/DELETE.
