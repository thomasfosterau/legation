# ADR-0030: Façade writes — journaled `POST`/`PATCH`/`DELETE`, write receipts, and where a rejection surfaces

Date: 2026-09-04
Status: Accepted 2026-10-23 with the #215 amendment (issue #169; extends ADR-0029 §7, which declared writes out of scope; amends ADR-0020's out-of-band-writer line)

## Context

ADR-0029 gave a plain-fetch client a replica-served `GET`. Its writes still
cross the network and fail offline, while the worker beside them holds a
durable journal that exists for exactly this. #169 asks for the missing
half: intercept `POST`, `PATCH` and `DELETE` on reflected routes, journal
them as mutations, apply them to the optimistic overlay, and answer the
request **before the server has ruled**.

That last step is the design problem. A plain-fetch caller expects
validation failure _in the response_. In the mutation-log model the server's
refusal is a **permanent rejection** (ADR-0008, CONTEXT.md): the backend
bumps the mutation id without applying effects, the client learns of it on a
later push or pull as a `MutationRejected`, and drops the optimistic effect
on the next rebase. By the time the server has ruled, the HTTP response is
long gone. The response the façade synthesises can therefore only ever be a
receipt for an _intent_, never a claim that the intent applied.

What exists today, for the record:

- **The read façade** (`JsonApiFacade.fetchHandler`, `packages/jsonapi/src/JsonApiFacade.ts`, #166)
  recognises a request by method, `Accept` and a reflected `list`/`getOne`
  route, and answers `undefined` for everything else. The commerce worker's
  `fetch` listener returns early on every non-`GET`
  (`examples/commerce/src/service-worker.ts`).
- **Route reflection** (`Convention.reflectResources`,
  `packages/jsonapi/src/Convention.ts`) already classifies `POST /{type}`,
  `PATCH|PUT /{type}/:id` and `DELETE /{type}/:id` as `create`, `update`
  and `delete` per type; the façade simply ignores them.
- **Derived CRUD mutators** (`packages/jsonapi/src/Derive.ts`) exist per
  reflected type, named `{type}/create|update|delete`. `CreateArgs`
  _requires_ a client id. Their rows are `JsonApiRow`s — attributes flat,
  `relationships` nested — the shape the client-direct stack
  (`JsonApiSync`, no node graph) stores. A node-graph replica stores a
  different shape: a flat row whose `one` edges live in their `via` key,
  which is what `DocumentWriter` reads (`row.value[edge.via]`) and what
  the sync tier ships from `SqlBackend`'s tables. The façade is built from
  `nodes` (ADR-0029), so every replica it fronts holds the flat form.
- **The journal seam in a worker.** The host owns the engine
  (`ServiceWorkerHost.start` returns `host.engine`, ADR-0010/0021).
  `ClientEngine.mutateWithAck(mutator, args)` journals, applies the
  optimistic overlay, signals a push, and returns a `MutationHandle` —
  `{ mutationId, acknowledged }` — the only entry point that hands back
  the mutation's id. `mutate`/`mutateEncoded` return `void`.
- **Mutation state** (`packages/effect/src/MutationState.ts`, #116) is a
  map keyed by `mutationId` — `pending | acknowledged | rejected | dropped`
  with `mutator`, `journaledAt`, `settledAt` and the rejection `reason` —
  exposed as `ClientEngine.mutationStates` (current map first, then every
  fold) and broadcast whole to every mirror. It is seeded from the journal
  at boot, so pending entries survive a worker restart; terminal entries
  are in-memory only and evicted beyond `mutationStateRetention.maxTerminal`
  (default 200).
- **Delivery over `JsonApiBackend`** (`packages/jsonapi/src/JsonApiBackend.ts`,
  #160): per-resource writes are _at-least-once_ — "make writes idempotent
  (client-generated ids on create; PATCH/DELETE are naturally idempotent)"
  — and any 4xx but 408/429 is classified as a `MutationRejected`. The
  atomic path (`atomic`) is exactly-once per batch; a pointer-named 4xx
  rejects one operation and the batch is resent without it; creates carry
  the client id; `lid` is unused.
- **The commerce server** pushes over `/sync` to a `Server` over
  `SqlBackend` (exactly-once by its transactional mutation-id ledger). Its
  mutators are named intents (`cart/add`, `review/write`, `order/place`,
  …); no handler answers to `reviews/create`. Its per-resource `create`
  handlers mint server ids and ignore `data.id`; its atomic operations
  endpoint (#167) honours a client id and makes a resend idempotent
  (`ownedOrFree` + `INSERT OR REPLACE`; a `remove` of a row already gone
  is a no-op).
- **Service workers never see CORS preflights.** A cross-origin `POST`
  with `Content-Type: application/vnd.api+json` preflights first; offline
  the preflight fails and the `fetch` event never fires.

Decisions taken in #149/#150 and not reopened: the journal stays the
outbox; subscriptions are explicit; coverage is ADR-0029 §3; the sync
protocol's push is unchanged; server-side handlers are #167's.

## Decision

Four decisions, one per question in #169, then the mechanics they share.

### 1. The synthesised response is a `202 Accepted` write receipt

An intercepted write is answered **`202 Accepted`** with a JSON:API
document: for `POST` and `PATCH`, the resource **as journaled** — read back
from the view through the one writer (`ReplicaDocuments.data`) after the
mutation is journaled, so the body is byte-equal to what a covered `GET` of
that resource returns next; for `DELETE`, a meta-only document. Every
receipt carries `meta.legation` and a `Location` header naming the
mutation's status URL (decision 2). The receipt is a **write receipt**: an
acknowledgement that the intent is durable and visible locally, never that
it applied.

**Status is never fabricated.** `201`, `200` and `204` are the server's
words for "applied"; the façade utters none of them. They reach the caller
only when the request was forwarded and the network round trip was
awaited (decision 3), untouched.

**Client id required.** A `POST` is interceptable only when `data.id` is a
non-empty string. `Derive.CreateArgs` already demands it, the receipt must
name a resource URL, and every later journal entry for that resource must
address it. A `POST` carrying only a `lid`, or no id, is never intercepted
(the decision table in §3 says what it gets instead). RFC 9110 §15.3.3 asks
a `202` to indicate the request's current status and point at a status
monitor; `meta.legation.status` and `Location` are exactly that.

Shapes, with the commerce api mounted at `/jsonapi` as the examples:

**`POST /jsonapi/reviews`** (offline, body `{ "data": { "type": "reviews", "id": "r-7f3a", "attributes": { "authorName": "Ana", "rating": 5, "body": "…", "createdAt": "2026-09-04T09:00:00Z" }, "relationships": { "product": { "data": { "type": "products", "id": "p-1" } } } } }`)

```http
HTTP/1.1 202 Accepted
Content-Type: application/vnd.api+json
Cache-Control: no-store
Location: /jsonapi/_legation/mutations/42
x-legation-served-at: <cookie>

{
  "data": {
    "type": "reviews",
    "id": "r-7f3a",
    "attributes": { "authorName": "Ana", "rating": 5, "body": "…", "createdAt": "2026-09-04T09:00:00Z" },
    "relationships": { "product": { "data": { "type": "products", "id": "p-1" } } },
    "links": { "self": "/jsonapi/reviews/r-7f3a" }
  },
  "meta": { "legation": { "status": "pending", "mutationId": 42, "mutation": "/jsonapi/_legation/mutations/42" } }
}
```

**`PATCH /jsonapi/cartItems/ci-9`** (body `{ "data": { "type": "cartItems", "id": "ci-9", "attributes": { "qty": 3 } } }`): `202`, same headers, `data` is the row as the overlay now shows it — the merge of the confirmed row and the patch, serialised with the declared linkage — and the same `meta.legation`. When the replica does not hold the row, the merge has nothing to merge over; the derived `update` is journaled all the same (the server merges authoritatively) and `data` carries only the attributes the request sent.

**`DELETE /jsonapi/cartItems/ci-9`**: `202`, same headers, body

```json
{
  "meta": {
    "legation": {
      "status": "pending",
      "mutationId": 43,
      "mutation": "/jsonapi/_legation/mutations/43"
    }
  }
}
```

A document with only `meta` is valid JSON:API. The resource is gone from
covered `GET`s at once (the overlay deletes it) and reappears only if the
server rejects the delete.

`meta.legation` on a receipt always reads `status: "pending"`; the other
phases live on the status resource. `x-legation-served-at` is the replica's
cookie at journal time (ADR-0029 §4), and `Cache-Control: no-store` holds
as for every façade response. When the receipt was produced because the
caller asked for it (§3's `Prefer: respond-async`), the response also
carries `Preference-Applied: respond-async` (RFC 7240 §3).

**Why `202` and the resource as journaled.** The caller wrote a resource
and gets it back in the shape the replica will show until the server
rules, plus one pointer to where the ruling will land. Nothing in the body
pretends to be the server's: attributes the server computes (a `userId` it
sets from identity, a recomputed `totalCents`) are absent, because the
replica does not have them yet either. A client that reads `202` as "done"
was wrong about HTTP before it met legation.

**Rejected alternative: `201 Created` with the journaled resource.** Every
JSON:API client library treats `201` as "the server created it"; a later
rejection would contradict a status the caller has already acted on, and
there is no HTTP vocabulary for un-creating. Also rejected: `200` for
`PATCH` (same reason) and `204` for `DELETE` (a `204` cannot carry the
status pointer).

### 2. Rejections surface on a mutation status URL, and on the streams that already exist

**The mutation status URL.** Every receipt points at
`{baseUrl}{prefix}/_legation/mutations/{mutationId}`, a `GET` route the
façade serves from `ClientEngine.mutationStates` — never the server, which
has no such resource. `prefix` is the reflected route's own prefix
(`/jsonapi` for `/jsonapi/reviews`), so the URL sits beside the api it
belongs to and is same-origin with it; `_legation` is a segment no JSON:API
resource type can be. The status resource:

```http
GET /jsonapi/_legation/mutations/42
Accept: application/vnd.api+json

HTTP/1.1 200 OK
Content-Type: application/vnd.api+json
Cache-Control: no-store
x-legation-served-at: <cookie>

{
  "data": {
    "type": "legation-mutations",
    "id": "42",
    "attributes": {
      "phase": "rejected",
      "mutator": "reviews/create",
      "journaledAt": 1788858000000,
      "settledAt": 1788858020000,
      "reason": "Review rejected: rating out of range"
    },
    "links": { "self": "/jsonapi/_legation/mutations/42", "resource": "/jsonapi/reviews/r-7f3a" }
  }
}
```

- `phase` is `MutationState.MutationPhase` verbatim: `pending`,
  `acknowledged`, `rejected`, or `dropped` (a paced compaction; façade
  writes are never paced, listed for completeness). `reason` is present
  only when `rejected`; `settledAt` only once settled. The args are not
  exposed — the status is about the intent's fate, not its content — and
  the resource link is derived from the mutator name and the args' `id`
  through the intent mapping (§5).
- **Lifecycle.** `pending` is durable: the journal seeds the map at boot,
  so a worker restart keeps every pending status. A terminal phase is
  in-memory and retained up to `mutationStateRetention.maxTerminal`; a
  worker composing the façade should raise it (the commerce follow-up
  does). Beyond the retention window, or after a worker restart, a
  settled mutation is gone.
- **`404 Not Found`** with `code: "unknown_mutation"` when the id is not in
  the map: never journaled by this engine, settled and evicted, or settled
  before this worker instance started. The three are indistinguishable
  today and the `detail` says so (open point 1). The status URL is
  answered by the façade only; with no worker controlling the page the
  request reaches the server and gets the server's 404.
- **`Prefer: wait=N`** (RFC 7240 §4.3) on the status `GET` holds the
  response until the mutation leaves `pending` or `N` seconds elapse
  (capped by the façade, default 30 s — a `respondWith` promise must not
  outlive the worker's patience), answering the current phase either way
  with `Preference-Applied: wait=N` when the wait was honoured. This is the
  one-round-trip way for a plain-fetch caller to learn the ruling without
  polling: `POST`, then `GET Location` with `Prefer: wait=10`.

**The streams.** A façade write is an ordinary journal entry, so it also
appears wherever journal entries already do: `Client.mutationStates`
(#116) in every tab (the host broadcasts the whole map, `mutator`
`reviews/create`), `mutationEvents`/`engineEvents` on the engine, and the
optimistic overlay's effect on live queries and `observeChanges`. An app
with a `Client` needs nothing new to see a plain-fetch write and its fate.

**The trade, stated.** A plain-fetch app that never asks — no `Location`
follow-up, no `Client` — sees **eventual convergence and nothing else**: a
rejected create disappears from covered `GET`s on the next rebase, a
rejected update reverts, a rejected delete reappears. No later request to
the resource ever surfaces the rejection as an HTTP error: a `GET` of a
rejected create's id is forwarded and returns the server's 404, exactly as
if the resource had never existed. That is ADR-0008's semantics seen from
HTTP, and the only honest one: the intent was refused, the state
converged, and the receipt said `pending`, not `created`.

**Checked against ADR-0008.** A `MutationRejected` on push or pull means:
the mutation id was bumped without effects, mutations behind it still
apply, the engine drops its optimistic effect on the next rebase, and
nothing is retried. For a receipt already answered that means the status
resource flips to `rejected` with the backend's reason (the string
`MutationRejected.reason` carried — commerce's `"insufficient stock"`, or
`JsonApiBackend`'s `"JSON:API write returned HTTP 422"`), the mutation's
overlay effect vanishes, and later façade writes that depended on it are
judged on their own: a `PATCH` journaled after a rejected `POST` of the
same id is a separate mutation the server will reject (404) with its own
status. Until it is, its overlay effect stands — §5 makes the derived
`update` a no-op on an absent row precisely so a dependent patch leaves no
phantom behind a rejected create.

**Rejected alternative: holding the response until the server rules.**
Offline there is no server to wait for, and online the whole point of the
journal is that the request and the ruling are decoupled; a held response
would reintroduce the network into the write path and hang against a
worker lifetime. `Prefer: wait` on the status URL gives the same
convenience where it is wanted, with a bound. Also rejected: a rejection
_callback_ (a `postMessage` to clients) as the primary channel — it would
reach only pages with JavaScript listening, which is what the streams
already serve.

### 3. Online, writes forward unchanged; the façade journals offline or on request

**Default.** When online and not asked otherwise, an interceptable write is
**forwarded to the network unchanged and journaled nothing** — today's
behaviour. The server applies it, broadcasts, and the next pull brings the
row into the replica. Journaling it as well would apply the same write
twice against a server that is also the sync backend, and would replace
the server's own validation response with a receipt the caller did not ask
for.

**Offline** — ADR-0029 §4's definition, both halves: `navigator.onLine` is
`false`, or the forward rejected at the transport — the write is journaled
and answered with a receipt. For the second half the worker calls the
façade back with the request it cloned before forwarding
(`facade.offline(request)`, replacing today's `offlineResponse()` call for
candidates): a request whose forward rejected may or may not have reached
the server, and journaling it is safe only because §4 makes every
interceptable write idempotent under replay. A status code from the server
is never offline, so a `5xx` is passed through and journals nothing, as
today.

**Opt-in, per request, by `Prefer`** (RFC 7240):

- `Prefer: respond-async` — journal and answer the receipt even when
  online. This is the read-your-writes switch: a forwarded write is
  visible in a covered `GET` only after the pull that carries it, whereas
  a journaled one is in the overlay before the receipt is sent. The
  response carries `Preference-Applied: respond-async`.
- `Prefer: handling=strict` — never journal; offline, answer `503`
  `offline` instead of a receipt. For writes whose caller would rather
  fail than defer (a payment step).

A `Prefer` the façade does not apply is forwarded with the request, as
every header is; the server may honour or ignore it.

**After a successful forward** (`2xx`) the façade signals `engine.pull` in
the background. The server's own broadcast pokes the client anyway; the
explicit pull shortens the window in which a covered `GET` right after the
write does not yet show it. The window is not closed — an app that needs
its write visible in the very next read uses `respond-async`.

**The decision table**, per method. "Interceptable" means: a reflected
`create`/`update`/`delete` route for a type the node graph declares,
`Accept` naming `application/vnd.api+json`, `Content-Type` naming it for
`POST`/`PATCH` (parameters aside — the atomic extension parameter makes a
request _not_ a candidate), a body that decodes structurally (§5), and for
`POST` a client `id`.

| Situation                                        | `POST` with client id | `POST` without id      | `PATCH`               | `DELETE`           |
| ------------------------------------------------ | --------------------- | ---------------------- | --------------------- | ------------------ |
| Online, no `Prefer`                              | forward, then pull    | forward, then pull     | forward, then pull    | forward, then pull |
| Online, `Prefer: respond-async`                  | journal, `202`        | forward (not applied)  | journal, `202`        | journal, `202`     |
| Online, `Prefer: handling=strict`                | forward               | forward                | forward               | forward            |
| Offline (`navigator.onLine === false`)           | journal, `202`        | `503` offline + reason | journal, `202`        | journal, `202`     |
| Offline, `Prefer: handling=strict`               | `503` offline         | `503` offline          | `503` offline         | `503` offline      |
| Forward rejected at the transport                | journal, `202`        | `503` offline          | journal, `202`        | journal, `202`     |
| Route not reflected, wrong media type, `PUT`     | forward               | forward                | forward               | forward            |
| Body malformed / `type` or `id` mismatch, online | forward               | forward                | forward               | forward            |
| Body malformed / mismatch, offline               | `400` / `409` / `422` | `400` / `409` / `422`  | `400` / `409` / `422` | — (no body)        |
| Engine refuses the mutation (unknown mutator)    | forward / `503`       | —                      | forward / `503`       | forward / `503`    |

The "forward" cells are ADR-0029 §4's forward: same URL, headers and body;
whatever the app composes next handles it, and the server's `201`/`200`/
`204`/`4xx` returns untouched. The error documents:

- `503` offline: ADR-0029 §4's document, `code: "offline"`, unchanged. For
  a `POST` without a client id a second error object is appended,
  `code: "client_id_required"`, `source: { "pointer": "/data/id" }`,
  `detail` explaining that an offline create needs a client-generated id.
  For a mutation the engine refuses (a `MutatorError`: the intent mapping
  named a mutator the engine does not register), the second error is
  `code: "not_journalable"` with the error's message.
- `400`, `code: "invalid_document"`: no `data` member, `data` not an
  object, `attributes`/`relationships` not objects. `409`,
  `code: "type_mismatch"` when `data.type` is not the route's type, and
  `409`, `code: "id_mismatch"` when a `PATCH`'s `data.id` differs from the
  path — the statuses JSON:API prescribes for the same faults, so answering
  them offline is no divergence from the server. `422`,
  `code: "unsupported_relationship"` when the payload carries a `many`
  relationship (§5). Attribute _values_ are not validated by the façade
  (§5); a bad value is the server's ruling and surfaces as a rejection.

Every façade-synthesised response — receipts, status documents, errors —
carries `Content-Type: application/vnd.api+json`, `Cache-Control:
no-store` and `x-legation-served-at`, as in #166.

**Rejected alternative: journal every write, online too.** It would give
read-your-writes by default, at the cost of double application against a
server that is also the sync backend, of hiding the server's validation
response from a caller that expects it, and of turning every plain-fetch
app into a journal user whether it knows it or not. The opt-in keeps that a
choice per request. Also rejected: a per-type static policy instead of
`Prefer` (it cannot express "this one write must not defer"); and a custom
`x-legation-*` request header (RFC 7240 already names both preferences,
and a standard header survives proxies and documentation better).

### 4. Idempotency: client ids plus mutation ids make replay safe; `lid` is not adopted

Replay happens on two paths and the argument must hold on both: the
**sync path** (the journal replays the intent on every rebase locally, and
the push delivers it once per mutation id to a cooperating `Server`; a
`SqlBackend` ledger is transactional, ADR-0008), and the **HTTP path** (a
`Server` over `JsonApiBackend` replays each intent as a `POST`/`PATCH`/
`DELETE`, at-least-once, or as one atomic batch, exactly-once per batch).

| Method   | Journaled intent               | Local replay (rebase)                         | Duplicate HTTP delivery, server honouring client ids                                                                                               | Atomic path (#167)                                 |
| -------- | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `POST`   | `{type}/create` with client id | `put(type, id)`: same row every time          | `409 Conflict` (the row exists). No second row. `JsonApiBackend` classifies it `rejected` — a **false verdict**, the state is right (open point 2) | `ownedOrFree` then `INSERT OR REPLACE`: applied    |
| `PATCH`  | `{type}/update`, attribute set | merge over the current row; no-op when absent | `200`; the same attributes set again. Applied                                                                                                      | applied                                            |
| `DELETE` | `{type}/delete`                | `del(type, id)`: no-op when absent            | `204` on a server whose delete is idempotent (commerce); `404` on a strict one, a false `rejected` (open point 2)                                  | `remove` of a row already gone is a no-op: applied |

**Why the client id and not `lid`.** A create journaled under a `lid`
would need the server-assigned id back to rewrite the overlay row, the
receipt's `links.self`, and every later journal entry addressing the
resource; `MutationOutcome` carries no payload and the push response has
no channel for it, so adopting `lid` is a protocol change — out of scope.
The client id costs nothing: `CreateArgs` already requires it, JSON:API
1.1 allows it, and the atomic push already sends it. A server that does
**not** honour client ids on `POST` — commerce's per-resource `create`
handlers today, which mint `r-…`/`ci-…` ids and ignore `data.id` — is
disqualifying for intercepting creates on that route: the replica would
hold the client's id while the server holds another, the overlay row
would vanish on acknowledgement, and every dependent `PATCH`/`DELETE`
would be rejected. The app declares which types the façade may intercept
(`writes` option, §5), and owning that declaration means owning the
server's side of it: either the per-resource handler honours `data.id`
under #167's `ownedOrFree` rule, or the push goes through the atomic
endpoint. The commerce follow-up does the former; `JsonApiSync` already
selects the latter when the api advertises the extension.

**Duplicate delivery and the receipt, checked against the at-least-once
note.** The note asks for idempotent writes so that retries are safe. Under
this design a duplicate delivery of any interceptable write **never
double-applies** and never yields a second resource: the create names its
id, the update sets the same attributes, the delete addresses the same row.
What a duplicate _can_ do on the per-resource path is produce a **false
`rejected`** on the status URL — a `409` for the create the server already
holds, a `404` for the delete it already performed — while the replica
still converges to the correct state on the next pull (the server's row
arrives; the overlay drops either way). The atomic path has no such case
after #167's review fixes. Two consequences: the receipt's promise ("the
intent is durable and will be applied or rejected") holds on both paths;
the status resource's verdict is exact on the sync path with a
cooperating `Server` and on the atomic path, and may be conservative on
the per-resource HTTP path. Open point 2 names the smallest adapter change
that closes it; nothing in the push protocol needs to move.

**Rejected alternative: server-assigned ids via a synchronous `POST` when
online, journal only offline.** That is the default column of §3's table
already; the point here is that _interception_ requires the id, so an api
that cannot accept one cannot have offline creates, and no amount of
façade cleverness changes that. Also rejected: compacting a journaled
`POST` and a later `DELETE` of the same id into nothing — ADR-0008's hard
boundary (never reorder or drop a journaled entry the push may hold) is
enforced in the engine, and intent order is the sync model's whole claim.

### 5. Mechanics: how a write reaches the journal, and what the overlay shows

**Recognition.** `JsonApiFacade.fetchHandler` grows the write routes:
`Convention.reflectResources(api)`'s `create`, `update` and `delete` per
type join the `list`/`getOne` routes, and a new fixed route
`GET {prefix}/_legation/mutations/:id`. `matches(request)` is true for a
`POST`/`PATCH`/`DELETE` on one of them under `baseUrl` with the media
types of §3, and for the status route; the commerce worker's listener
therefore stops returning early on non-`GET` and asks `matches` for every
method. A `PUT` route reflected as `update` is not intercepted (JSON:API
has no `PUT`; its replace semantics are not the derived `update`'s merge).

**Decoding to a `Write`.** The request body is read once (the worker
clones the request before forwarding) and decoded structurally into
`JsonApiBackend.Write` — `{ operation, type, id, attributes?,
relationships? }`, the unit both delivery paths already speak. Structural
means: `data` is an object whose `type` is the route's and whose
`attributes`/`relationships` are objects when present; nothing else. The
façade has the node graph, not the server's payload codec, and a value the
graph's attribute schema would refuse is still the server's ruling: it is
journaled as sent and rejected authoritatively, exactly as a bad
`Client.mutate` argument to a permissive mutator would be.

**The intent mapping.** A `Write` becomes the mutation the engine
journals through one function, `intentOf(write) → { mutator, args } |
undefined` (`undefined`: not interceptable, §3's last row). The default is
the **graph-derived CRUD mutations**: for every node the graph declares,
`{type}/create`, `{type}/update` and `{type}/delete` — `Derive.ts`'s names,
kept so `JsonApiBackendConfig.operations` and devtools read the same
vocabulary — whose args are in the **graph row form**:

- `create`: `{ type, id, attributes }` where `attributes` is the resource
  attributes plus, for each `one` edge the graph declares, its `via` key
  taken from the request's `relationships[name].data.id` (`null` linkage
  clears the key). A `many`/`paginated` relationship in a payload has no
  home on the parent row (it is the children's foreign keys) and makes the
  write not interceptable: forwarded online; offline, `422`,
  `code: "unsupported_relationship"`, `source.pointer` naming it.
- `update`: the same shape with only the attributes and `one` linkage the
  request sent; the local handler merges over the current row and is a
  **no-op when the row is absent** (unlike `Derive.ts`'s handler, which
  puts a partial row; the difference is what keeps a dependent patch from
  leaving a phantom behind a rejected create, §2).
- `delete`: `{ type, id }`.

Args schemas are permissive (`attributes: Record<String, Unknown>`), as
`Derive.ts`'s are, so the JSON body _is_ the encoded form and
`mutateWithAck` can journal it as decoded without a transforming codec
(open point 3 covers mappings that need one). The arg schemas and local
handlers depend only on the graph, so by ADR-0006 they belong in
`@thomasfosterau/legation-effect`; the JSON:API halves — `Write` → graph args, and the
inverse, graph args → `Write` (relationships rebuilt from `via` keys), which
a `JsonApiBackend` over a graph app passes as `writes` — are one codec in
`@thomasfosterau/legation-jsonapi`. An app whose intents differ (commerce's `cart/add`
with its `userId` and stock rule) may pass its own `intentOf`; the default
is what a plain-fetch write means when nobody said otherwise.

**The journal seam.** In the worker the façade is handed
`host.engine.mutateWithAck` (an option beside `view` and `coverageOf`) and
calls it directly: the worker owns the engine, so the write goes into the
engine's journal, never over the mirror channel (`EngineHost.handleMutate`
serves mirrors, not the worker itself). The handle's `mutationId` names
the status resource; its `acknowledged` effect is not awaited — the
receipt is answered as soon as the mutation is journaled and the overlay
applied, and the sync loop's `signalPush` takes it from there (debounced;
held until reconnect by the transport's connectivity awareness). Both
sides of the mutation must be registered: the client handlers from the
graph derivation merged into the engine's registry, and a server handler
per name — `SqlBackend` handlers over the app's write rules (commerce's
follow-up lifts #167's per-resource rules into `reviews/create`,
`cartItems/create`, `cartItems/update`, `cartItems/delete`,
`orders/create`), or `JsonApiBackendConfig.operations`/`writes` for a
`Server` over a REST api.

**The overlay and later `GET`s.** Journaling applies the mutation's local
handler to the overlay and publishes the change: every mirror's live
queries update, and a covered façade `GET` — which reads the view with the
overlay, #166 — shows the row at once. The receipt's `data` is that view.
An uncovered `GET` goes to the network and shows the server's state, as
ADR-0029 §4 says; the asymmetry is unchanged and now matters for writes:
a plain-fetch app that wants to see its own offline write keeps its reads
within covered windows. One consequence for scoped collections deserves
its own line: the optimistic row holds exactly what the request carried,
so a subscription scoped by a server-set key (`where userId = …`) does not
match a `POST /orders` whose payload omits `userId`; the write is visible
in that window only once the pull confirms it. An app that wants it
visible sends the scoping attribute and lets the server handler verify it
against identity, as commerce's `cart/add` already does.

**Unknown routes.** A write on a route the façade does not reflect —
nested routes, relationship endpoints, custom actions, the atomic
operations endpoint, `/sync*` — is not the façade's business: the worker
does not `respondWith`, the request goes to the network as it does today,
and offline it fails as the network fails. In particular an
`atomic:operations` request is never decomposed into journal entries: the
journal has no batch boundary, and the atomic push batches per push, not
per client request.

**CORS, credentials, media types.**

- The façade is a same-origin device. A `baseUrl` on another origin can be
  intercepted only while online and only after the browser's preflight
  succeeded — the preflight itself bypasses the service worker — so
  **offline writes require a same-origin api** (an origin-relative
  `baseUrl` such as `/jsonapi` or a proxied `/proxy` path). This is a
  platform constraint, not a design choice, and the façade documents it
  rather than working around it.
- A synthesised `Response` is readable by the page whatever the request's
  `mode` and `credentials` were; the façade adds no CORS headers. A
  forwarded request keeps its credentials mode, as it keeps everything.
- `Accept` must name `application/vnd.api+json` (`*/*` is not a candidate,
  #166's amendment); `Content-Type` must name it on `POST`/`PATCH`; a
  `DELETE` has no body and no `Content-Type` requirement. The atomic
  extension's `ext` parameter marks the operations endpoint, not a
  candidate. The status route needs only `Accept`.
- `Prefer` values the façade applied are echoed in `Preference-Applied`;
  the `Prefer` header is otherwise forwarded intact.

### Worked example: an offline review, rejected

The commerce shell has pinned `allReviews` (`reviews`, unwindowed). The
tab is offline. A no-JS enhancement script posts
`POST /jsonapi/reviews` with `id: "r-7f3a"`, `rating: 7`, product `p-1`.

1. The façade matches the `create` route for `reviews`, sees
   `navigator.onLine === false`, decodes the body to a `Write`, and the
   default intent mapping yields `reviews/create` with args
   `{ type: "reviews", id: "r-7f3a", attributes: { authorName, rating: 7, body, createdAt, productId: "p-1" } }`.
2. `mutateWithAck` journals mutation 42, puts the flat row in the overlay,
   signals a push (held: offline). The façade reads
   `ReplicaDocuments.data` for `reviews/r-7f3a` and answers the `202` of
   §1 with `Location: /jsonapi/_legation/mutations/42`.
3. `GET /jsonapi/reviews?filter[productId]=p-1&sort=-createdAt` is covered
   (rule 3: the request's conjuncts include the subscription's empty set)
   and lists `r-7f3a` first, from the overlay; the tab's `useQuery` over
   `productReviews("p-1")` shows it too.
4. Reconnect. The push carries mutation 42 to `/sync`; the server's
   `reviews/create` handler (the follow-up's, over #167's rule "rating out
   of range" → `MutationRejected`) refuses it; the push response lists it
   in `rejected`, `lastMutationIds` bumped past 42.
5. The engine folds `rejected` into the state map, resolves the handle,
   drops the overlay on the next rebase: `r-7f3a` leaves the list and the
   live query. `GET /jsonapi/_legation/mutations/42` answers `phase:
   "rejected"`, `reason: "rating out of range"`. `GET /jsonapi/reviews/r-7f3a`
   is forwarded and returns the server's 404.

Had the rating been 5, step 4 acknowledges 42, step 5 shows
`acknowledged`, the pull delivers the confirmed row with the server-set
`userId`, and the overlay row is replaced by it with no visible change.

### Worked example: online, the default and the opt-in

Same tab, online. `POST /jsonapi/reviews` without `Prefer` is forwarded;
the server answers `201` with its own document; the façade pulls in the
background; a covered `GET` a moment later shows the row once the pull
lands. The same request with `Prefer: respond-async` is journaled and
answered `202` + `Preference-Applied: respond-async`; the covered `GET`
shows the row immediately; the push goes out on the debounce.
`DELETE /jsonapi/cartItems/ci-9` with `Prefer: handling=strict` while
offline is answered `503` `offline` and never journaled.

## Consequences

- **The receipt is the contract.** A `202` with `meta.legation.status:
  "pending"` and a `Location` means "durable, visible locally, not yet
  ruled on". Clients that treat it as `201` are wrong in a way the
  status code already tells them.
- **`JsonApiFacade` gains three obligations** and no engine: write
  routes and the status route in `matches`; `handle` answering receipts,
  status documents and the new error documents; `offline(request)` for
  the transport-failure half. Its options grow `mutate` (the engine's
  `mutateWithAck`), `intentOf` (default: the graph-derived CRUD
  mutations) and `writes` (which types/methods may be intercepted; default
  every reflected write route). The read path is untouched.
- **Graph-derived CRUD mutations become a first-class derivation** in
  `@thomasfosterau/legation-effect`, beside `Derive.ts`'s resource-derived ones in
  `@thomasfosterau/legation-jsonapi`; the two share names and differ in row shape, which
  the module docs must say plainly. The `update` no-op-on-absent rule is
  the one semantic difference and is deliberate.
- **The server side of every intercepted route is the app's.** Handlers
  under the derived names; `POST` handlers that honour `data.id`. The
  commerce example carries the reference implementation over #167's
  write rules, so the atomic endpoint, the REST handlers and the sync
  mutators keep one rule set.
- **Worker composition changes** in the commerce example: the listener
  consults `matches` for every method and clones write bodies;
  `lib/facade.ts` restates the server's write routes beside its read
  routes; `mutationStateRetention.maxTerminal` is raised.
- **Read-your-writes across a forwarded write is eventual**, shortened by
  the post-forward pull and closed only by `Prefer: respond-async`. The
  documentation says so where it documents the façade.
- **Same-origin only, offline.** Cross-origin apis get online forwarding
  and nothing else; the README states the preflight reason.
- **`x-legation-served-at` extends to every write response**, so the
  commerce tests can assert "received locally at cookie X" for a `202` as
  they do for a `200`.
- **No changeset accompanies this ADR.** ADR-only commits carry none in
  this repository (ADR-0029); the implementation issues carry their own.
- **CONTEXT.md carries the rows below** (added on acceptance, 2026-10-23).

## Open points

Each is answered as far as the current engine allows, with the smallest
change that would close it. None blocks the implementation issues; each is
a candidate follow-up.

1. **Terminal status durability.** `MutationState` is in-memory beyond the
   journal: a settled mutation's phase is lost on worker restart and beyond
   `maxTerminal`, so the status URL's `404` conflates "never existed",
   "evicted" and "settled before this worker started". Smallest change:
   persist the outcome of façade-journaled mutations in the `ClientStore`
   (one small table keyed by mutation id, written where `settleApplied`/
   `rejectAck` fold the map), and let the façade read it when the map has
   no entry. Until then, raise `maxTerminal` in the worker and document the
   window.
2. **False `rejected` on duplicate per-resource delivery.** `JsonApiBackend`
   classifies every 4xx but 408/429 as permanent; a resent `POST` with a
   client id gets `409`, a resent `DELETE` on a strict server `404`, and
   the status resource reports a rejection the server never made. Smallest
   change, in the adapter and not the protocol: on `409` for a create
   carrying a client id, and on `404` for a delete, confirm with
   `GET /{type}/{id}` and classify as applied when the resource exists
   (create) or does not (delete). The atomic path needs nothing.
3. **`mutateEncoded` returns no handle.** The default intent mapping's
   permissive schemas make `mutateWithAck` sufficient. A custom `intentOf`
   whose mutator has a transforming args schema needs to journal the
   _encoded_ body and still learn the mutation id; smallest change: make
   `mutateEncoded` return the `MutationHandle` (source-compatible for
   callers that ignore it), or add `mutateEncodedWithAck`.
4. **Rejection reason fidelity.** `RejectedMutation.reason` is one string;
   a server's error document (`code`, `source.pointer`) does not survive
   the push. The status resource shows the string. A structured `errors`
   member on the push response is a protocol addition and stays out of
   scope; noted so that nobody reads `reason` as the server's document.

## What was rejected

- **`201`/`200`/`204` for a journaled write** — §1.
- **Holding the response for the ruling; a `postMessage` rejection
  channel** — §2.
- **Journal every write online; static per-type policy; a custom opt-in
  header** — §3.
- **`lid` with a server-assigned id; local compaction of `POST`+`DELETE`**
  — §4.
- **Decomposing an `atomic:operations` request into journal entries** — §5.
- **Validating attribute values in the façade.** The server rules; the
  façade has the graph's attribute schemas but a divergence between them
  and the server's payload codec would make the façade refuse what the
  server accepts. Structural checks only.
- **Requiring coverage to intercept a write.** The journal needs no
  subscription; coverage decides visibility, not durability (§5).

## CONTEXT.md rows

Added to CONTEXT.md on acceptance. Under **Writes**:

| Term                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Façade write**        | A `POST`/`PATCH`/`DELETE` on a reflected JSON:API route that the façade journals as a mutation instead of forwarding — offline, on a forward that rejected at the transport, or on `Prefer: respond-async` — through the default **intent mapping** to the graph-derived CRUD mutations (`{type}/create\|update\|delete`, graph row form). Online and unasked, writes forward unchanged (ADR-0030). |
| **Write receipt**       | The façade's `202 Accepted` answer to a façade write: the resource as journaled (read back through the one writer), `meta.legation.status = "pending"`, and a `Location` naming the mutation status URL. A receipt for the intent, never the server's ruling; `201`/`200`/`204` are only ever the server's.                                                                                         |
| **Mutation status URL** | `{prefix}/_legation/mutations/{mutationId}`, served by the façade from the engine's mutation state (#116): one `legation-mutations` resource with the mutation's phase, mutator, timestamps and rejection reason; `404 unknown_mutation` beyond the retention window; `Prefer: wait=N` holds for the ruling. Where a plain-fetch caller learns of a permanent rejection.                            |
| **Intent mapping**      | The function from a JSON:API write (`Write`: one create/update/delete of one resource) to the mutation the engine journals — the façade's `intentOf`, the inverse of `JsonApiBackendConfig.writes`. Default: the graph-derived CRUD mutations.                                                                                                                                                      |

And in the **Façade** row under Reads, append: "Writes: see **Façade
write** (ADR-0030)."

## Amendment (#215): a form action runs a named Mutation, with the same receipt semantics

Decided 2026-10-23, together with this ADR's acceptance. #215 is the
second interception point for the same intent: a SvelteKit form action, the
primary write surface of the apps adopting legation (Gardeneria alone has 72
routes exporting `actions`). ADR-0020 made form actions **out-of-band
writers** (ADR-0019): they commit through the app's API and publish hints,
so every write was authored twice, once as a `Mutation` and once as an
action, and the two could drift. `Mutation`'s premise is "defined once,
executed twice" (CONTEXT.md); this section restores it for actions.

**1. An action that can name the client group runs a named Mutation as
one of that group's mutations.** The server decodes the posted args against
the Mutation's args schema, runs the **same handler the push path runs**,
bumps the mutation id in the **same transaction** as the handler's effects
(permanent rejection bumps it without effects, ADR-0008), and broadcasts as
a pushed write does. It is a push minus the transport: identity is resolved
for the group through `IdentityResolver`, middleware and auth apply as on
`/sync`, and the mutation-id ledger gives exactly-once. The group comes
from ADR-0020's client-group cookie; an action that cannot name a group (no
cookie, another service, a cron) stays an **out-of-band writer**, unchanged.

**2. The mutation's identity travels with the form.** A mutation id is per
_client_ and contiguous (the backend rejects a gap), so the action cannot
borrow the next id of a tab's engine without colliding with its journal.
Each rendered form carries a fresh **form client** id and mutation id `1`
in hidden fields, minted when the page renders it (server-side for the
no-JS page, per submit by the enhanced one). A resubmission of the same
rendered form is the same mutation: the ledger already covers it, the
handler does not run again, and the action answers the original outcome.
That replaces the apps' hand-rolled `idempotentCreate` (client id plus a
re-fetch as proof of its own retry), and works for every Mutation, not only
creates.

**3. The action returns a receipt naming the mutation, not a claim about
the page.** Its result carries `{ clientId, mutationId, phase, reason? }`,
where `phase` is `MutationState`'s vocabulary: `acknowledged`, or
`rejected` with the backend's reason (which the form layer may route to a
root message). These are the **same receipt semantics** as §1–§2: the
caller learns the mutation's id and where its ruling lives, and the
optimistic overlay is released only when the authoritative effect is
observed, **never on the response itself**. The two entry points differ
only in timing: the façade answers before the server rules (`pending`, ruling
on the status URL); the action runs on the server, so its receipt already
carries the ruling.

**4. A JS page reconciles on that id instead of waiting for a pull.** An
enhanced submit applies the Mutation's local handler to the overlay under
the form client's id — not journaled, since the action is its delivery and
a push would apply it twice. On the action's receipt the engine moves the
entry to the **unpulled tail** (acknowledged, held in the overlay) or drops
it (`rejected`), and signals a pull; the pull whose `lastMutationIds`
covers the form client's id reveals the confirmed rows and releases it,
exactly as for a pushed mutation. SvelteKit's post-action `load` re-run is
then optional: the page already shows the write, and the progressively
enhanced form behaves better than the unenhanced one rather than merely as
well.

**5. Field-level validation stays the form layer's.** A Mutation's args
schema and a form's field errors are different shapes. The seam is "this
decoded, validated command is now a Mutation invocation"; the form layer
(`@thomasfosterau/effect-forms` in the apps) runs first and hands over args.
A decode failure of the args against the Mutation's schema is a defect of
that hand-over, not a field error.

**6. Placement (ADR-0006).** Running a named Mutation for a group needs
only `effect` and the backend contract, so the mechanism is core: an entry
point on `Server` beside `handler` and `broadcast` (`@thomasfosterau/legation-effect`;
the name is the implementation's). `@thomasfosterau/legation-svelte/kit` adds only
what binds to SvelteKit: reading the group and form-client fields from
`Cookies` and the request, and the enhanced submit's client half. An app on
another framework calls the core entry point directly.

**Relationship to the façade write.** Both are interception points for one
intent and do not contradict each other: a façade write journals a
plain-fetch request on the client and answers `202 pending`; a form-action
Mutation runs on the server and answers the ruling. Both name the mutation
by id, neither fabricates a status the server did not give, and both
release the optimistic effect only when a pull observes it. A page should
use one path per write, not both for the same submission.

**Open points** (candidate follow-ups; none blocks #215's implementation):

5. **Form-client ledger growth.** One form client per rendered form adds
   one `lastMutationIds` entry per submission to the group. The ledger
   needs a retention rule for form clients (a TTL longer than any
   plausible resubmission); none exists for ordinary clients either.
6. **Enhanced submit while offline.** The action cannot run; the enhanced
   path could journal the Mutation through the engine instead (a different
   client id, so a later replay of the form would be a second mutation).
   Until decided, the enhanced submit fails as the network fails.

Implementation: #215 (the core entry point, the Kit plumbing, the two
tests its acceptance criteria name); the façade side is #510 (receipts),
#511 (status URL) and #512 (error documents).
