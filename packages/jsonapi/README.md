# @legation/jsonapi

JSON:API v1.1 collection loaders for the
[`@legation/effect`](https://github.com/thomasfosterau/legation/tree/main/packages/effect)
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
npm install @legation/jsonapi @legation/effect effect
```

`effect`, `@legation/effect`, and
`@thomasfosterau/effect-jsonapi` are required alongside this package. It
targets Effect v4 beta (`effect@>=4.0.0-beta.107`).

## The happy path: sync an existing JSON:API

`JsonApiSync` reflects an app's Effect `HttpApi`, classifies its endpoints into
JSON:API CRUD roles by convention (method + path), derives one collection and
the available CRUD mutators per resource type, and composes the whole
client-direct sync stack — journal, optimistic overlay, rebase, live queries —
over the existing REST API.

```ts
import { Duration, Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ClientEngine, Predicate, Subset } from "@legation/effect";
import { JsonApiSync } from "@legation/jsonapi";
import { api } from "./my-json-api"; // your app's Effect HttpApi

const sync = JsonApiSync.layer(api, {
  baseUrl: "https://api.example.com",
  clientId: "device-1",
  clientGroupId: "user-42",
}).pipe(Layer.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  // Run the sync loop + background polling (lives until the scope closes).
  yield* JsonApiSync.start({ pollInterval: Duration.seconds(5) });

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

## Standalone collection loading

`CollectionLoader` reads JSON:API endpoints into rows directly. Every helper is
an `Effect` requiring an `HttpClient` and a `JsonApiSource`.

```ts
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Filter } from "@thomasfosterau/effect-jsonapi";
import { CollectionLoader } from "@legation/jsonapi";

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
import { ClientEngine, Subset } from "@legation/effect";
import { Relationships } from "@legation/jsonapi";

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

`JsonApiQuery` is the bridge between the **filter grammar** (ADR-0028 — the
one filter language shared by REST URLs, sync predicates and the façade,
owned by effect-jsonapi) and the engine's plan:

- **Filter AST ⇄ `Predicate`** — `fromFilterAst(ast)` is total: every
  grammar node has an engine node. `toFilterAst(predicate)` is partial and
  returns `None` where the grammar has no form: `Exists` (server-only), an
  empty `In` / `NotIn` list, a `null` literal. `foldConstants` folds the two
  definite cases away exactly (an empty `In` is false, an empty `NotIn` true)
  before anything is encoded.
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
import { CollectionLoader, ApiError, ParseError } from "@legation/jsonapi";

CollectionLoader.load("articles").pipe(
  Effect.catchTag("ApiError", (error) => Effect.logError(error.errors)),
  Effect.catchTag("ParseError", (error) => Effect.logError(error.message))
);
```

## License

MIT
