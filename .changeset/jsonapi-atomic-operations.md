---
"@thomasfosterau/legation-jsonapi": minor
---

Push the journal as one `atomic:operations` request when the server advertises
the JSON:API Atomic Operations extension (#160). `JsonApiBackendConfig.atomic`
(`{ path }`) switches `applyMutations` from one `POST`/`PATCH`/`DELETE` per
mutation to a single all-or-nothing request per batch — `create` → `add`,
`update` → `update`, `delete` → `remove`, sent with the extension's media type
— and `JsonApiSync.layer` fills it in automatically when the reflected api has
an endpoint taking an `atomic:operations` document (effect-jsonapi's
`Endpoint.operations`); `JsonApiSyncOptions.atomic: false` opts out, `{ path }`
names the endpoint explicitly.

Delivery over the atomic path is exactly-once per batch rather than
at-least-once: the in-session ledger advances only once the server has applied
every operation. A transient failure (transport, 5xx, or a 4xx naming no
operation) moves nothing and the client retries the batch; a 4xx error document
whose `source.pointer` names an operation is a permanent rejection of that
mutation — it is reported in `rejected`, the batch is resent without it, and
every mutation is then acknowledged in order (the poison-mutation semantics of
ADR-0008). Change hints come from the result document's resources. Creates
keep sending the client-generated `id`; `lid` is supported by the wire format
but unused until a mutator needs a server-assigned id. The per-request path is
unchanged and still documented as at-least-once.

Route reflection now recognises an atomic operations endpoint structurally (a
request payload with a top-level `atomic:operations` member) and skips it:
previously `POST /operations` classified as `create` on a phantom `operations`
resource, which derived a phantom collection and mutator. `Convention` gains
`reflectAtomic` and `isAtomicEndpoint`; `JsonApiSync.inspect` reports the
endpoint as `atomic`. Reflected endpoint refs now carry the endpoint's
`identifier` as their `name` (Effect 4 renamed the field).

Also: `JsonApiBackendConfig.writes` expresses mutators beyond the derived CRUD
ones as JSON:API writes (a `Write` is one create/update/delete of one
resource), which is what lets `BackendContract.verifyBackendContract` run over
the backend in atomic mode against an effect-jsonapi `Endpoint.operations`
server; the atomic path rejects mutation-id gaps as the contract requires; and
`getRows` now omits a row the server answers `404` for instead of failing.
