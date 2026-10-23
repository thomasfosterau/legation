# @thomasfosterau/legation-jsonapi

JSON:API v1.1 collection loaders for the
[`@thomasfosterau/legation-effect`](../effect)
sync engine, built on [Effect](https://effect.website).

In the engine's model (ADR-0008) a JSON:API **`type` is a collection**, a
resource **`id` is a row id**, and a **resource is a row value**. This package
maps JSON:API documents into engine collection rows and — through a
convention-first derivation — wires an app's existing JSON:API REST API into the
full offline/optimistic sync engine with no bespoke backend to write.

It is **read-side**: reads come from JSON:API documents, while writes are the
engine's named mutators (create/update/delete replayed as `POST`/`PATCH`/`DELETE`,
or pushed as one `atomic:operations` request when the server supports the
[Atomic Operations extension](https://jsonapi.org/ext/atomic/)), not ad-hoc
REST calls.

The JSON:API wire types/schemas and query encoding are adopted from
[`@thomasfosterau/effect-jsonapi`](https://www.npmjs.com/package/@thomasfosterau/effect-jsonapi)
(the spec-compliant source of truth); this package layers the generic,
resource-agnostic loaders on top (ADR-0016).

> This package was formerly published as `@thomasfosterau/effect-chancery`.

## Install

```sh
npm install @thomasfosterau/legation-jsonapi @thomasfosterau/legation-effect effect
```

`effect` and `@thomasfosterau/legation-effect` are required alongside this package;
`@thomasfosterau/effect-jsonapi` is a regular dependency.

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.2` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR); install one copy of `effect` in your app (ADR-0003).

## The happy path: sync an existing JSON:API

`JsonApiSync` reflects an app's Effect `HttpApi`, classifies its endpoints into
JSON:API CRUD roles by convention (method + path), derives one collection and
the available CRUD mutators per resource type, and composes the whole
client-direct sync stack — journal, optimistic overlay, rebase, live queries —
over the existing REST API.

```ts
import { Duration, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Predicate } from "@thomasfosterau/legation-effect";
import { ClientEngine, Subset } from "@thomasfosterau/legation-effect/internal";
import { JsonApiSync } from "@thomasfosterau/legation-jsonapi";
import { api } from "./my-json-api"; // your app's Effect HttpApi

const sync = JsonApiSync.layer(api, {
  baseUrl: "https://api.example.com",
  clientId: "device-1",
  clientGroupId: "user-42",
  // Both legs are opt-in: without `pushDebounce` a journaled mutation waits
  // for a reconnect, a poke-driven pull, or an explicit `push` — an
  // already-connected client would sit on unflushed writes. `pullInterval`
  // is the correctness backstop for when pokes don't arrive.
  pullInterval: Duration.seconds(5),
  pushDebounce: Duration.millis(300),
}).pipe(Layer.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  // Run the sync loop (push-on-mutate + periodic pull; lives until the scope closes).
  yield* JsonApiSync.start;

  const engine = yield* ClientEngine.ClientEngine;
  const open = Subset.make({
    collection: "articles",
    where: Predicate.eq("status", "open"),
  });

  yield* engine.subscribe(open);
  yield* engine.pull;
  return yield* engine.query(open);
}).pipe(Effect.provide(sync), Effect.scoped);

const articles = await Effect.runPromise(program);
```

`JsonApiSync.layer` requires an `HttpClient` and returns a ready `ClientEngine`.
The CVR store and invalidation bus are in-process and the client store is
in-memory; swap in a durable `ClientStore` layer for offline persistence across
reloads.

### Endpoint conventions

Endpoints are classified by HTTP method and path shape — no per-endpoint
annotation required. The resource `type` is the last static path segment (any
`/api` or version prefix is ignored):

| Method        | Path shape    | Role     |
| ------------- | ------------- | -------- |
| `GET`         | `/{type}`     | `list`   |
| `GET`         | `/{type}/:id` | `getOne` |
| `POST`        | `/{type}`     | `create` |
| `PATCH`/`PUT` | `/{type}/:id` | `update` |
| `DELETE`      | `/{type}/:id` | `delete` |

A CRUD mutator is derived only when its endpoint exists (no `POST /{type}` ⇒ no
`create` mutator). Endpoints that don't fit the table (nested routes, custom
actions) are simply not part of the derived sync surface. Use
`JsonApiSync.inspect(api)` to see the reflected resources, collections,
mutators, operations, and the atomic operations endpoint (below), if any.

### Atomic operations

If the api advertises the JSON:API
[Atomic Operations extension](https://jsonapi.org/ext/atomic/) — an endpoint
whose request payload is an `atomic:operations` document, such as
effect-jsonapi's `Endpoint.operations([...])` (conventionally
`POST /operations`) — `JsonApiSync` detects it and pushes each batch of
journalled mutations as **one request**: `create` → `add`, `update` →
`update`, `delete` → `remove`, sent with the extension's media type. The
endpoint is recognised by its payload, not its path, so it never reads as a
phantom `operations` resource.

```ts
JsonApiSync.layer(api, { ...options, atomic: false }); // one request per mutation
JsonApiSync.layer(api, { ...options, atomic: { path: "/batch" } }); // an explicit endpoint
```

Delivery over the atomic endpoint is all-or-nothing per batch: nothing is
acknowledged until the server has applied every operation. A transient failure
(transport, 5xx, or a 4xx that names no operation) leaves the server holding
nothing and the client retries the whole batch. A 4xx error document whose
`source.pointer` names an operation (`/atomic:operations/{index}`) is a
permanent rejection of that mutation: it is reported as rejected, the batch is
resent without it, and every mutation in the batch is then acknowledged in
order — the poison-mutation semantics of the core contract. Creates keep
sending the client-generated `id`; `lid` is supported by the wire format but
unused until a mutator needs a server-assigned id.

Without the endpoint, each write is its own `POST`/`PATCH`/`DELETE` and
delivery is at-least-once: keep writes idempotent (client-generated ids on
create; `PATCH`/`DELETE` are naturally idempotent).

Mutators beyond the derived CRUD ones can ride the same backend: give
`JsonApiBackend.make` a `writes` map from mutator name to a function expressing
its decoded args as one JSON:API `Write` (a create, update or delete of one
resource), and both delivery paths carry it.

### The ledger across restarts

The backend keeps a ledger for each client group: the highest acknowledged
mutation id per client, so a resent mutation that was already applied is
skipped, and the permanent rejections it has made, so a replayed copy and a
pull can report them with their reasons.

By default, with no durable store, the ledger lives in the memory of the backend
instance, and **a restart of the backend forgets it**. A resent mutation that was
already applied then looks new, guarded only by the server's own idempotency if it
has any, and a permanent rejection is forgotten, so neither a replayed copy nor a
pull can report it.

The ledger is durable when its store is. `Ledger.keyValue` keeps each group's
ledger in an Effect `KeyValueStore`, which survives a restart when that store
does, such as a file system, SQL or browser storage layer. Pass the durable
key/value store your client store is built over as `keyValueStore`, and
`JsonApiSync.layer` uses it for both: the client store defaults to
`ClientStore.layerKeyValue()` over it, and the ledger defaults to
`Ledger.keyValue` over it, so the journal and the ledger survive a reload together:

```ts
import { JsonApiSync } from "@thomasfosterau/legation-jsonapi";

JsonApiSync.layer(api, {
  ...options,
  // The durable key/value store (e.g. the one from the browser wiring below).
  keyValueStore,
});
```

An explicit `store` replaces the default client store, and an explicit `ledger`
overrides the default ledger. If you pass both `store` and `keyValueStore`, build
`store` over the same key/value store: the layer cannot check that, because
`store` is an opaque layer. Pass `ledger: Ledger.keyValue(keyValueStore)` yourself
to name a store the client store does not use, and `JsonApiBackend.make` takes the
same `ledger` option for a server built by hand.

The client store and the ledger must be durable together. A durable `ledger`
with the in-memory client store loses writes silently: a reload restarts the
client's mutation ids at 1, the ledger already acknowledges them, and the
backend skips the new writes as already applied. A durable `store` with the
in-memory ledger stalls instead: a reload forgets the acknowledged ids, and the
backend refuses every later push with a mutation-id gap. Passing
`keyValueStore` covers both.

A ledger store is a `Ledger.LedgerStore` with two operations, `read` and
`write`, for one client group's ledger. Write your own to keep the ledger
somewhere else.

In the browser, `IndexedDbClientStore` keeps its key/value store internal to
`@thomasfosterau/legation-browser`, so take one from `@effect/platform-browser`
instead and provide it to the layer:

```ts
import { Effect, Layer } from "effect";
import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { KeyValueStore } from "effect/persistence";
import { JsonApiSync } from "@thomasfosterau/legation-jsonapi";

const syncLayer = Layer.unwrap(
  Effect.gen(function* () {
    const keyValueStore = yield* KeyValueStore.KeyValueStore;
    return JsonApiSync.layer(api, { ...options, keyValueStore });
  })
).pipe(
  Layer.provide(
    BrowserKeyValueStore.layerIndexedDb({ database: "legation-jsonapi" }).pipe(
      Layer.provide(IndexedDb.layerWindow)
    )
  )
);
```

Name its `database`: the platform default, `effect_key_value_store`, is the
database `IndexedDbClientStore` uses by default. This store is durable, but it
is not `IndexedDbClientStore`: it has no atomic batch, so the client store
commits a pull's release through a release record that is finished on the next
open if a crash interrupts it, rather than in one IndexedDB transaction (#393).
It also opens its database at version 1, so it cannot open a database another
version has upgraded.

The ledger is keyed by `clientGroupId` under one prefix. If one key/value store
holds more than one identity's ledgers on a device, give each identity its own
prefix (`IndexedDbClientStore.layerNamespaced` does the same for its own client
store), and pass the prefixed store as `keyValueStore` so the client store and
the ledger share it:
``KeyValueStore.prefix(kv, `legation/identity/${Identity.keySegment(identity)}/`)``,
where `identity` is the identity's `Identity.Fingerprint` (the string
`IndexedDbClientStore`'s `identity` option takes), `Identity` comes from
`@thomasfosterau/legation-effect` and `KeyValueStore` from `effect/persistence`.
Otherwise identities that share a `clientId` and `clientGroupId` share one
ledger, and one identity's mutations can be skipped as already applied.

Each ledger change is written after the server has applied the writes it
acknowledges and before the ids are acknowledged. If that ledger write fails
after the server write succeeded, the push fails with a `BackendError`.
Mutations acknowledged earlier in the same push keep their acknowledgement; the
failed one and the rest of the push are not acknowledged, so the client's resend
re-applies them. On the atomic path a rejection recorded before the failing write
stays remembered, and the resend records it again. That is the same window as a
crash between the two writes, with or without a store, and the server's own
idempotency is what guards it. A store that fails to read also
fails the push with a `BackendError`, and fills no cache. A stored value that does
not decode fails it too, so a corrupt store is never read as an empty ledger. Run
one backend instance per server (see [Row cache](#row-cache)), so one store is
written by one instance.

### Change hints

Each push reports the rows it wrote as change hints, which fan-out uses to poke
the subscribers whose windows those rows match. A hint carries each row's value
after the push (`values`) and, for each row an update or delete touched, its
value before the push (`oldValues`), so a row that moved out of a window still
pokes that window.

A REST API exposes no change token, so the old value is read rather than
cached: each update or delete makes one `GET /{type}/{id}` before its write,
once per row per push, on both the per-resource and the atomic path. Each such
read is an extra request. A row the push creates was absent before the push, so
it is not read and has no old value. The one exception is on the atomic path: a
create the server refuses, followed by an update or delete of the same row in
the same batch, is read once the refusal arrives, before the batch is resent, so
that later write carries the row's pre-push value.

Every update or delete carries its old value or is not sent. A read that fails
for any reason fails the push with a `BackendError`: a transport error, a 5xx, a
408 or 429, a 4xx such as 403, a 404 (the row is absent), or a 2xx whose document
names no resource. On the atomic path nothing has been written by then, so the
retry reads again. On the per-resource path the writes before the failed read
have already applied and been acknowledged, so the retry does not resend them
and their hints are lost: that path is at-least-once, and a transient write
failure loses those hints the same way.

A refused read stalls the client's queue until the read can succeed or the
client is reset. Two consequences follow:

- Deleting a row that is already gone fails with a 404 on the read, so every
  retry fails the same way. The delete used to be acknowledged as a no-op.
- A create the server refuses for a reason other than a conflict (a 422, say)
  stalls the queue in the same way when a later update or delete in the same
  push touches that row. The row is absent, so its read finds a 404.
- The stall reaches the application through the sync loop. The `BackendError`
  arrives at the client as a `TransportError`, the client's retry policy retries
  it (by default, exponential backoff from 1 second, capped at 30 seconds, for
  five retries), and the push then surfaces as a `SyncFailure` with
  `operation: "push"` on `syncFailures`. The loop does not retry in a tight
  loop. With `syncLoop.pushDebounce` set, the next push comes with the next
  local mutation; otherwise it waits for a reconnect or an explicit `push`.
- The ledger belongs to one backend instance unless it has a durable store (see
  [The ledger across restarts](#the-ledger-across-restarts)). After a
  restart without one, a delete that had already applied is sent again, its read
  finds nothing, and the queue stalls in the same way.

A resource that receives updates or deletes must have a `getOne` route, since
that is how its rows are read. A push that contains one of its updates or
deletes (one whose args decode) fails with a `BackendError` before any write in
that push is sent, on both paths, which stalls that client's queue until the
route exists. A resource
that only receives creates needs no `getOne` route.

### Row cache

`getRows` serves a row from the backend's cache when it holds one. The cache
takes the rows a listing (`evaluate`) returns, and the value each write this
instance applies leaves a row with; a write the server rejects or fails leaves
its row as it was. A delete this instance applies removes its row from the
cache. The cache reflects this instance's own writes only, and nothing tells it
about writes made elsewhere. So run one `JsonApiBackend` per JSON:API server,
and write that server only through it: with a second instance, or another
writer, `getRows` can serve a row that has since been changed or deleted. A row
not in the cache is fetched with `GET /{type}/{id}`, which needs a `getOne`
route.

## Standalone collection loading

`CollectionLoader` reads JSON:API endpoints into rows directly. Every helper is
an `Effect` requiring an `HttpClient` and a `JsonApiSource`.

```ts
import { Effect } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Filter } from "@thomasfosterau/effect-jsonapi";
import { CollectionLoader } from "@thomasfosterau/legation-jsonapi";

const program = CollectionLoader.load("articles", {
  include: ["author"],
  sort: [{ field: "createdAt", direction: "desc" }],
  filter: Filter.eq("status", "published"),
  page: { number: 1, size: 20 },
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(CollectionLoader.JsonApiSource, {
    baseUrl: "https://api.example.com",
  })
);

const { rows, included } = await Effect.runPromise(program);
```

- `load(type, options?)` — `GET /{type}` → `{ rows, included }`.
- `loadOne(type, id, options?)` — `GET /{type}/{id}` → a single row, or
  `undefined` if absent.
- `documentToRows(document)` — map an already-parsed `JsonApiDocument` to its
  primary rows and its compound `included` rows.

The request `options` are a `JsonApiRequestOptions`: `include`, `fields`,
`sort` (the library's `{ field, direction }` term shape), `filter` (a filter
grammar AST — `Filter.eq("status", "published")`, `Filter.and(...)` — encoded
exactly through the grammar's canonical `filter[...]` form), and `page` (an
offset/limit, number/size, or cursor/size strategy from the library's
`Query.Page`).

## Relationships

A JSON:API resource row carries relationship **linkage** (`{ type, id }`
references). Once the referenced collections are synced into the local mirror, a
relationship name resolves to the related row value(s) — a client-side join over
already-synced data, no extra request.

```ts
import { Effect, Stream } from "effect";
import { ClientEngine, Subset } from "@thomasfosterau/legation-effect/internal";
import { Relationships } from "@thomasfosterau/legation-jsonapi";

const program = Effect.gen(function* () {
  const engine = yield* ClientEngine.ClientEngine;
  const articles = Subset.make({ collection: "articles" });

  // Auto-subscribes the referenced collections and re-emits on any change.
  const joined = yield* Relationships.related(engine, articles, ["author", "tags"]);
  yield* Stream.runForEach(joined, (rows) =>
    Effect.sync(() => console.log(rows[0]?.related.author))
  );
});
```

- `related(engine, subset, names)` — auto-subscribes the base subset and the
  `id IN (...)` subsets of each referenced collection, then streams the resolved
  rows. Pair with the backend's `includes` config to deliver related rows in the
  parent's response (no extra round trip).
- `observe(engine, subset, names)` — a live, incrementally-maintained join
  (you manage the subscriptions).
- `query(engine, subset, names)` — a one-shot resolved snapshot.

## Query encoding, URL parsing, and canonical strings

`JsonApiQuery` is the façade-boundary bridge (ADR-0029 §6) between
effect-jsonapi's **filter grammar** — a query-parameter format, decoded from
untrusted URLs, its literals typed by a resource's declared attributes — and
`Predicate`, legation's own subset language (ADR-0028). They are two
different things, not two dialects of one language; this bridge is a
projection for one job, not a general translation:

- **Filter AST ⇄ `Predicate`** — both directions are partial, and neither is
  the other's inverse. `fromFilterAst(ast)` fails with a typed `QueryError`
  for a literal that is not a wire scalar or a `Date` (a `Date` becomes its
  ISO-8601 instant text — a load-bearing **encode**, not a copy, since
  ADR-0028 rule (e) fixes instant comparison to that exact format).
  `toFilterAst(predicate)` returns `None` where the grammar has no form:
  `Exists` (server-only), an empty `In` / `NotIn` list, a `null` literal.
  `foldConstants` folds the two definite cases away exactly (an empty `In`
  is false, an empty `NotIn` true) before anything is encoded. Both
  functions assume a **field-namespace precondition**: field names are
  copied verbatim, correct only because every caller here pre-synthesises a
  resource whose field names are already the engine's (`resourcesOf`).
- **URL → `Query.Read`** — `parseRead(nodes, url)` / `parseParams(nodes,
  collection, params)` decode `include`, `fields`, `sort`, `page` and `filter`
  with effect-jsonapi's `Query.schema` derived from the node graph (each
  node's filterable set and edges become the codec's declaration), then map
  them onto the read: `filter` → `where`, `sort` → `order`, `page[limit]` /
  `page[after]` → `first` / `after`, `include` → the edge selects (single
  level only). `fields[]` rides beside the read as a projection, never into
  the plan. A nested include path, an undeclared field or operator, a literal
  of the wrong kind, an unsortable field or a bad page fails with a
  `QueryError` whose `parameter` names the offending key — the 400's
  `source.parameter`.
- **`Query.Read` → canonical string** — `canonical(nodes, read)` compiles
  the read and encodes its plan through effect-jsonapi's canonical encoder:
  `/products?filter[categoryId]=c-audio&sort=id&page[limit]=12`. Two reads
  with one plan give one string, whatever their spelling; it is the
  subscription identity of ADR-0029, and `parseRead` accepts it back.

The shipped `defaultEncoder` is what `JsonApiBackend` pushes to the server:
the **whole** predicate as the grammar's canonical `filter[...]` form
(operators, `or`, `not`, `isnull`, `nin` included — nothing is dropped), plus
`orderBy` as `sort`. A subset whose predicate folds to false is answered
without a request. Order, cursor and limit stay local: `Subset.apply` still
finalises the window, now as redundancy over an exact filter rather than as
correction of a superset. Pass your own `queryEncoder` to `JsonApiSync.layer`
to match a server with a different filter contract.

## Derived REST handlers

A JSON:API `GET` is the engine's `read` operation (ADR-0025) with a document
body, so a `list` / `get` endpoint can be derived from the node graph instead
of hand-written: the URL is parsed by the one grammar, the request's identity
becomes a `SyncContext`, and the read runs through the same filterable check,
the same deny-by-default auth filters and the same `Backend.evaluate` +
`getRows` the sync tier runs — two carriers, one evaluator, one auth path.

```ts
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RestHandlers } from "@thomasfosterau/legation-jsonapi";
import { api, NotFound, Product } from "./my-json-api";
import { backend, nodes, policy } from "./my-server";

const rest = RestHandlers.make({
  nodes,
  backend,
  policy,
  // HTTP request → SyncContext: identity from the verified session, never from a client-supplied id.
  context: (request) =>
    Effect.succeed({ clientGroupId: "http", identity: request.headers["x-user"] }),
  prefix: "/api",
});

const productsLive = HttpApiBuilder.group(api, "products", (handlers) =>
  handlers
    .handle("list", rest.list(Product))
    .handle("get", rest.get(Product, { notFound: () => new NotFound() }))
);
```

What the derivation guarantees:

- **Scoping is the policy's.** A request without identity to a private
  collection sees the policy's empty allow-set: an empty collection for
  `list`, a 404 for `get` — exactly what the sync tier syncs. No `WHERE
  userId` lives in a handler.
- **Sorting and paging are `Subset.apply`'s** (ADR-0026 / ADR-0028): code-point
  text order, NULLs last, the id tie-break, `page[after]` as the cursor.
  `links.next` continues after the last row when the window is full.
- **A URL the grammar rejects is the codec's 400** with `source.parameter`,
  before any backend call; a collection the policy does not declare is a 403.
- **Includes resolve in two phases**, and every `Relationship.many` the
  endpoint's resource declares is resolved for linkage — on the primary and
  the included resources alike, since effect-jsonapi's resource schemas
  require every declared relationship — while nothing the resource does not
  declare is touched; `include` decides what is compounded into `included`.
  A paginated node edge lists and includes under a `Relationship.many`
  declaration (links plus its rows' linkage) and carries links only under
  `Relationship.paginated`.
- **`fields[type]` is a projection** applied at serialisation over full rows
  (ADR-0029 §5). A resource that serves sparse fieldsets declares its
  attributes `Resource.attribute(schema, { resource: "optional" })`, or the
  endpoint's success encoder refuses the sparse object.

Derivation is opt-in per endpoint, beside hand-written handlers on the same
api. The rows-to-document step is its own module, `DocumentWriter`: a pure
function of the node graph, the read, the resolved rows and the projection,
so the service-worker façade serving the same URL from the replica produces
the same document content (ADR-0029 §6).

## The same documents from the replica

`ReplicaDocuments` is the other caller of that one serialiser: it runs a URL
(or a parsed read with its `fields[]` projection) over a local view — the
rows the replica holds, optimistic overlay included — and writes the document
the derived REST handler would write for the same URL. It depends on nothing
but `effect` and the engine, so it runs where the engine runs, a service
worker included; the façade (ADR-0029) is built on it.

```ts
import { Effect } from "effect";
import { JsonApiQuery, ReplicaDocuments } from "@thomasfosterau/legation-jsonapi";
import { nodes } from "./my-domain";
import { CartItem, Product, Variant } from "./my-json-api";

const docs = ReplicaDocuments.make({
  nodes,
  // The resources the REST endpoints are declared with, so linkage matches them.
  resources: new Map([Product, Variant, CartItem].map((resource) => [resource.type, resource])),
  prefix: "/api",
});

// In the worker: serve only what the replica covers (ADR-0029 §3).
const serve = (url: string) =>
  Effect.gen(function* () {
    const { read } = yield* JsonApiQuery.parseRead(nodes, url);
    const verdicts = yield* Effect.forEach(yield* docs.toCover(read), (needed) =>
      client.coverageOf(needed)
    );
    if (verdicts.some((verdict) => verdict._tag === "Uncovered")) return undefined; // network
    return yield* docs.fromUrl(client.view, url); // a collection or single-resource document
  });
```

- **Linkage follows the same declarations.** Pass the resources the REST
  endpoints are declared with and the replica emits exactly the
  relationships the derived handler emits, by construction (one linkage
  derivation, two callers). Without `resources`, the node graph's synthetic
  resources (`JsonApiQuery.resourcesOf(nodes)`) apply: every collection edge
  resolved, paginated edges as `many`.
- **One grammar on both sides.** URLs are parsed with the node-derived codec,
  so parity holds when the endpoint is declared with the same codec
  (`JsonApiQuery.querySchema(nodes, collection)`, or equivalent declarations)
  and collection edges are `many`. An `include` edge or a `fields[type]` type
  the bound resource does not declare is refused with the codec's own
  `QueryError` shape before any query runs.
- **Coverage is the caller's guard.** The writer cannot tell a missing row
  from an absent one, so `toCover(read)` names the reads a request needs
  covered — the read itself, plus one whole-collection read per collection
  the declared linkage resolves from beyond the read's includes. Serve a URL
  only when every one is covered; an uncovered URL goes to the network.
- **`fromUrl` writes the shape the path asks for**: a single-resource
  document (`data: null` when the replica holds no row) for `/{type}/{id}`, a
  collection document otherwise. A URL the grammar rejects, or one naming a
  collection no bound resource declares, fails with a `QueryError` — never a
  defect, since a URL is network input.

## The façade: covered JSON:API `GET`s answered from the replica

`JsonApiFacade` is ADR-0029's third front over one engine: a fetch handler a
service worker composes **first** — before its HTTP cache and the network —
that answers a JSON:API `GET` from the replica when an explicit subscription
covers it, and stays out of the way otherwise. It is built from the app's
`HttpApi` (route reflection, as `JsonApiSync` does), the graph, the replica's
view and a coverage source; it lives here rather than in `@thomasfosterau/legation-browser`
because everything it needs is this package's plus the standard `Request` /
`Response` globals (ADR-0006).

```ts
import { Effect } from "effect";
import { ClientView, Coverage } from "@thomasfosterau/legation-effect/internal";
import { ServiceWorkerHost } from "@thomasfosterau/legation-browser";
import { JsonApiFacade, JsonApiQuery } from "@thomasfosterau/legation-jsonapi";
import { api, resources } from "./my-json-api"; // the HttpApi and its Resource declarations
import { nodes } from "./my-domain";

// In the worker, once the engine has booted:
const host = yield * ServiceWorkerHost.start({ nodes, urls: JsonApiQuery.urlReads(nodes) });
const view = ClientView.fromEngine(host.engine); // confirmed rows + optimistic overlay
const facade = JsonApiFacade.fetchHandler({
  nodes,
  api, // its `list` / `getOne` routes, prefix included, are what is recognised
  resources, // so linkage matches the derived REST handler's
  view,
  coverageOf: Coverage.coverageOf(nodes, view.query, host.registrations), // the mirrors' pins
  cookie: store.getCookie, // `x-legation-served-at`
});

self.addEventListener("fetch", (event) => {
  // Cloned before anything reads or forwards it: `offline` may need a write's body.
  const candidate = facade.matches(event.request) ? event.request.clone() : undefined;
  event.respondWith(
    Effect.runPromise(facade.handle(event.request))
      .then((local) => local ?? httpCacheThenNetwork(event.request))
      .catch(() =>
        candidate ? Effect.runPromise(facade.offline(candidate)) : fetch(event.request)
      )
  );
});
```

- **What it recognises.** A `GET` whose `Accept` names
  `application/vnd.api+json` on one of the api's reflected `list` / `getOne`
  routes whose type is a node of the graph, under `baseUrl` (default: the
  page's own origin). Everything else — a server-only resource, another
  path, a `POST`, a navigation — is `undefined`: not its business.
- **The parity assumption.** The api's read endpoints are declared with the
  graph's codec (`JsonApiQuery.querySchema` / `singleRowSchema`) and served
  by the derived handlers, so the server rules on a URL exactly as the
  façade does — which is what lets a parse failure be answered locally. A
  hand-written server with another grammar must not compose the façade.
- **What it answers.** A covered request: `200`, the document the one writer
  produces (byte-equal in content to the derived REST handler's for the same
  declarations), `Cache-Control: no-store`, and `x-legation-served-at` set to
  the replica's CVR cookie. A covered request is answered only once every
  window its rows link to has been pulled (a pull started after the window was
  made has applied). Until then, online, it is forwarded; after a restart
  nothing is pulled until the first pull lands, so offline it gets the `503`
  below. A URL the grammar
  rejects: the codec's `400` document, which the server would return
  identically — except an `include` the graph does not declare, which the
  server rules on. Uncovered and offline (`navigator.onLine === false`, or
  `online()`): the `503` `offline` error document of ADR-0029 §4.
- **What it forwards** (`undefined`): an uncovered request while online, a
  collection no bound resource declares, and a single-resource request whose
  row the replica does not hold — the 404 is the endpoint's own error class,
  which only the server can write. A forward that rejects at the transport
  is the other half of "offline": the worker answers it with
  `facade.offline(request)` (the same document, with the replica's cookie)
  when `matches(request)` held.
- **Coverage is the ledger's.** `coverageOf` is `Client.coverageOf` over a
  Client, or `Coverage.coverageOf(nodes, view.query, host.registrations)` over
  the registrations an `EngineHost` holds on its mirrors' behalf — the only
  ledger in a worker that knows what the tabs pinned. A registration is listed
  with the pulled state of its windows, and a covered read needs the windows its
  rows link to pulled (ADR-0029 amendment #426). Every read
  `ReplicaDocuments.toCover` names must be covered; the façade never
  subscribes on a request's behalf.
- **The overlay.** A covered response sees pending optimistic mutations as
  `Client.query` does; an uncovered network response is the server's
  authoritative answer and does not (ADR-0029 §4).
- **Offset pagination is covered by slicing, not by an offset window**
  (#209). `page[offset]` parses beside `page[after]` — the two are different
  pagination idioms, and a request naming both is a `400`. An offset read
  compiles to a plain limit-only window (`limit = offset + first`, no
  `cursor`), so it is covered by the ordinary rule: the subsuming
  subscription is unwindowed, or its own limit is at least `offset +
  first`. A deep offset past what is covered falls through exactly like any
  other uncovered window — the façade never fetches more rows to satisfy
  it, online or off. `links.next` / `links.prev` come back in the offset
  idiom when the request used it, never switching a caller to cursors
  mid-collection. See ADR-0029's amendment for the full rule and why an
  offset _window_ (as opposed to an offset _read_, translated at read time)
  was rejected.

### Façade writes: the `202` write receipt (ADR-0030)

Given the engine's journal seam, the façade also intercepts writes:
`POST /{type}` (with a client-generated `data.id`), `PATCH /{type}/:id` and
`DELETE /{type}/:id` on the api's reflected routes for a type the graph
declares, with `Accept` and (for `POST` / `PATCH`) `Content-Type` naming
`application/vnd.api+json` — the atomic extension's `ext` marks the operations
endpoint, never a façade write, and a `PUT` is never intercepted.

```ts
import { CrudMutation, Mutation } from "@thomasfosterau/legation-effect";

// The engine's registry carries the graph-derived CRUD mutations the façade journals …
const mutators = Mutation.registry([...myMutations, ...CrudMutation.entries(nodes, { writes })]);
// … and the façade is handed the worker engine's journal and pull.
const facade = JsonApiFacade.fetchHandler({
  ...readOptions,
  writes, // e.g. { reviews: ["create"] }: what the server has handlers for
  mutate: host.engine.mutateWithAck,
  pull: host.engine.pull,
});
// After a forwarded write: `event.waitUntil(Effect.runPromise(facade.forwarded(candidate, response)))`.
```

- **Online and unasked, a write is forwarded unchanged** and nothing is
  journaled; after a `2xx`, `facade.forwarded` signals `pull` so a covered
  read soon shows the server's row. `Prefer: handling=strict` is never
  journaled.
- **Offline** (`navigator.onLine === false`), **after a forward that rejected
  at the transport** (`facade.offline(clone)`), or **online with
  `Prefer: respond-async`**, the write is journaled as the graph-derived
  `{type}/create|update|delete` (`CrudMutation`, the graph row form: `one`
  relationships become their `via` keys; the default **intent mapping**, which
  `intentOf` replaces) and answered **`202 Accepted`**: `data` is the resource
  as journaled, read back through the one writer (for a `PATCH` of a row the
  replica lacks, the attributes sent), `meta.legation = { status: "pending",
  mutationId, mutation }`, and `Location` naming the mutation status URL
  `{prefix}/_legation/mutations/{mutationId}`; a `DELETE`'s receipt is
  meta-only. `Preference-Applied: respond-async` says when it was asked for.
  The façade never answers a write with `201`, `200` or `204`: those are only
  ever the server's.
- **The mutation status URL.** With `mutationStates` (the engine's
  `mutationStates`), the façade answers `GET {prefix}/_legation/mutations/{id}`
  itself, never forwarding it: `200` with one `legation-mutations` resource —
  `phase` (`pending`, `acknowledged`, `rejected`, `dropped`), `mutator`,
  `journaledAt`, `settledAt` once settled, `reason` only when rejected, and
  `links.self` / `links.resource` — or `404` `code: "unknown_mutation"` for
  an id the map does not hold (never journaled here, evicted beyond
  `mutationStateRetention.maxTerminal`, or settled before this worker
  started; indistinguishable, so raise `maxTerminal` in the worker).
  `Prefer: wait=N` holds a pending answer until it settles or `N` seconds
  pass, capped by `maxWait` (default 30 s), with `Preference-Applied: wait=N`:
  `POST`, then `GET Location` with `Prefer: wait=10`, learns the ruling in
  one round trip.
- **What it cannot journal.** Online, it is forwarded untouched. Offline
  (either half), `Prefer: handling=strict` gets the `503` `offline` document;
  a create without a client id the same document plus `client_id_required`
  (`source.pointer: "/data/id"`); a mutation the engine refuses (an intent
  mapping naming an unregistered mutator) plus `not_journalable`; and a
  malformed body the statuses JSON:API prescribes for it: `400`
  `invalid_document` (no `data`, `data` / `attributes` / `relationships` not
  objects), `409` `type_mismatch` / `id_mismatch`, `422`
  `unsupported_relationship` (a to-many relationship, which has no home on the
  row). Attribute values are never checked: a bad one is journaled and the
  server rules on it.
- **A receipt is not a ruling.** The server rules when the journal pushes; a
  permanent rejection drops the optimistic effect on the next rebase, and the
  write's fate is on `Client.mutationStates`. Attribute values are not
  validated by the façade.
- **The server side is the app's.** Every type and operation in `writes`
  needs a server handler under the derived name, and creates that honour the
  client id: a journaled name the server cannot handle stalls the push.
- **Same-origin only, offline**: a cross-origin write preflights, and the
  preflight bypasses the service worker.

## Types, schemas, and errors

JSON:API document types (`ResourceObject`, `JsonApiDocument`, `Relationship`,
`JsonApiError`, …) and their `Schema` codecs (`JsonApiSchema`) are exported for
direct use; `JsonApiSchema.decodeDocument` validates untrusted input (e.g. a
parsed response body) into a `JsonApiDocument`, failing with `ParseError`.

All errors are Effect `Data.TaggedError` types (`SyncError`, `NetworkError`,
`ParseError`, `ApiError`, `ConflictError`), so they match with
`Effect.catchTag` / `Effect.catchTags` and carry structured fields. `ApiError`
carries the JSON:API error objects returned by the server.

```ts
import { Effect } from "effect";
import { CollectionLoader, ApiError, ParseError } from "@thomasfosterau/legation-jsonapi";

CollectionLoader.load("articles").pipe(
  Effect.catchTag("ApiError", (error) => Effect.logError(error.errors)),
  Effect.catchTag("ParseError", (error) => Effect.logError(error.message))
);
```

## License

MIT
