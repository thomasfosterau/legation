# Adopting legation in an existing JSON:API app

**First, the trap that catches everyone: subscriptions are explicit.**
The façade answers a JSON:API `GET` from the replica only when an explicit
`Client.subscribe(url)` (or `subscribe(read)`) covers it. Nothing subscribes
on fetch, and no subscription expires
([ADR-0029 §2](adr/0029-replica-served-jsonapi-facade.md)). A façade
composed with no subscriptions covers nothing **and raises no error**: every
request is forwarded, and the app behaves exactly as it did before. To
check what was served locally, look for the `x-legation-served-at` response
header (`JsonApiFacade.servedAtHeader`). It is present on every answer the
façade wrote, carrying the replica's CVR cookie, and absent on anything that
came from the network.

This guide is for an app that already has a working JSON:API, server-side
`load`s and possibly a service worker, and that wants to hand legation one
layer at a time. Each phase below has an entry condition and a sign that it
works. It describes current behaviour only. Vocabulary follows
[`CONTEXT.md`](../CONTEXT.md).

Incremental adoption is safe to try for one reason: **a coverage false
negative costs one round trip, never wrong data**
([ADR-0029](adr/0029-replica-served-jsonapi-facade.md), Consequences). A
request the façade cannot prove covered goes to the network unchanged, so a
missing subscription, a declaration you have not added yet or a read shape
the façade does not cover only makes the app as slow as it was before.

## Phase 1: reads, with no app changes

The service worker answers covered JSON:API `GET`s from the replica, and the
app's own `fetch` calls stay as they are.

**Entry condition.**

- The app's resources are `Resource.make` definitions (effect-jsonapi), and
  `NodeBridge.registry` bridges them into a node graph
  (`@thomasfosterau/legation-jsonapi`). Every mismatch throws a
  `ResourceBridgeError` when the graph is built, so the graph either bridges
  completely or fails at startup.
- **Parity.** The server's `list` / `get` endpoints are declared with the
  graph's codec (`JsonApiQuery.querySchema` for a `list`, `singleRowSchema`
  for a `get`) and served by the derived handlers (`RestHandlers`). The
  façade answers a URL its grammar rejects with a local `400`, and a covered
  URL with its own document, both on the assumption that the server would
  answer the same. A hand-written server with another query grammar must not
  compose the façade (`JsonApiFacade` module doc).
- The filterable and sortable declarations are on the resources: see
  [Trap 2](#trap-2-declare-what-may-be-filtered-and-sorted).
- An engine host runs in a service worker: `ServiceWorkerHost.start`
  (`@thomasfosterau/legation-browser`,
  [ADR-0010](adr/0010-service-worker-hosted-client-engine.md)), given
  `urls: JsonApiQuery.urlReads(nodes)` so that subscriptions can be named by
  URL. A `Client` built without `urls` fails `subscribe(url)` with a
  `QueryError`.
- The worker's `fetch` listener asks `JsonApiFacade.fetchHandler(...)`
  **first**, before any HTTP cache and before the network, and calls
  `facade.offline` when a forwarded candidate request rejects at the
  transport. The commerce example's `src/service-worker.ts` and
  `src/lib/facade.ts` show the composition.
- The app subscribes to the URLs it wants served locally, for example a
  layout's shell reads at boot.

**You'll know it's working when** a `GET` of a subscribed URL comes back
with `x-legation-served-at` and `Cache-Control: no-store`, and with the
same body the server would have sent
([ADR-0029 §6](adr/0029-replica-served-jsonapi-facade.md)). An
unsubscribed URL still comes back from the network with no such header.

## Phase 2: SSR

> **With the engine in a service worker, this phase is not available yet.**
> `clientRuntime` hydrates a store it builds in the page, but with
> Phase 1's topology the store is the worker's. The tab-to-worker hand-off
> is designed (a proposed host-request envelope in ADR-0021, #146) and not
> yet built.
> Until it is, a service-worker app seeds its hooks from the page's own
> `load` (each hook's `initial` option), and the steps below apply to an app
> whose engine runs in the page.

The server renders a page's data from a snapshot of the same sync
conversation the browser continues, so the first paint has data and the
browser's first pull continues from the server's cookie.

**Entry condition.** Phase 1's node graph, and a sync `Server` the
rendering process can reach: in-process, as the `ServerHandler` in
context, or over a `transport` (for example `BindingTransport` from
`@thomasfosterau/legation-alchemy-cloudflare` for a separate API Worker).

**What to add.**

- In the existing server `load`, call `loadSnapshot(cookies, { nodes, reads })`
  (`@thomasfosterau/legation-svelte/kit`). It reads or mints the
  client-group cookie and runs `Hydration.snapshot` under that group
  ([ADR-0020](adr/0020-sveltekit-integration.md)). Return
  `{ snapshot, clientGroupId }` in the page data. Outside SvelteKit, call
  `Hydration.snapshot` directly with the browser's group id.
- In the browser, boot with the same group id and the snapshot:
  `clientRuntime({ snapshot, ... })` hydrates it with
  `Hydration.hydrateIfEmpty`, which applies it only to an empty store. A
  repeat visit's durable rows, cookie and journal are fresher than any
  snapshot.

**You'll know it's working when** the server-rendered HTML already
contains the rows, the components' first client render shows them with no
loading state (`Hydration.rowsFor` gives the hooks their initial value),
and the browser's first `/sync` pull returns a patch from the snapshot's
cookie rather than starting a new conversation.

## Phase 3: writes

Writes go through the engine's journal instead of around it, so they are
optimistic, survive going offline, and are acknowledged exactly once. There
are two entry points with the same receipt semantics
([ADR-0030](adr/0030-facade-writes.md)). Use one, or both.

**Façade writes**: an app whose browser code writes with plain `fetch`.

- **Entry condition.** Phase 1's façade, given the worker engine's journal
  (`mutate: host.engine.mutateWithAck`, `pull: host.engine.pull`), and `writes`
  naming each type and operation the server has a handler for. The engine's
  registry carries the graph-derived CRUD mutations
  (`CrudMutation.entries(nodes, { writes })`). The server must accept a
  client-generated `id` on create, since a journaled create carries one.
- **What changes.** Online and unasked, a write is forwarded unchanged and
  nothing is journaled. It is journaled, and answered with a
  `202 Accepted` **receipt**, in three cases: offline, after a forward that
  rejected at the transport, or with `Prefer: respond-async`. The receipt's
  `meta.legation.status` is `"pending"`, and its `Location` is the mutation
  status URL. A receipt is never a ruling: `201` / `200` / `204` only ever
  come from the server, and a later rejection drops the optimistic effect.
  The [legation-jsonapi README](../packages/jsonapi/README.md#façade-writes-the-202-write-receipt-adr-0030)
  has the full status table.
- **You'll know it's working when** a `POST` with the network off comes back
  `202` with `meta.legation.status: "pending"`, a covered `GET` shows the new
  row at once, and after reconnecting, `GET` on the `Location` (with
  `Prefer: wait=10`) reports `acknowledged`.

**Form-action Mutations**: an app whose writes are SvelteKit form actions.

- **Entry condition.** The page's `load` mints a form client
  (`mintFormClient`). The action calls `runFormMutation(server, target,
  mutation, args)` with the same named Mutation the JS path journals,
  where `target` is `formMutationTarget(cookies, data)`. The enhanced form uses
  `enhanceFormMutation` (`@thomasfosterau/legation-svelte/kit`).
- **What changes.** A write is authored once. A resubmission of the same
  rendered form is the same mutation, applied once. A JS page reconciles on
  the action's receipt instead of re-running its `load`. An action that
  cannot name the client group (no group cookie) stays an out-of-band writer.
- **You'll know it's working when** submitting the same rendered form twice
  applies once, and an enhanced submit updates the page optimistically before
  the action returns.

Writes the engine does not carry stay **out-of-band**: a hand-written
endpoint, an import job, an admin tool. They bypass the mutators, so they
must announce themselves (`Server.broadcast`, or a hint source,
[ADR-0019](adr/0019-change-data-capture.md)) for subscribers to be poked.
Without that, subscribers converge only on their next pull.

## Phase 4: offline

The replica answers covered reads with no network, and journalled
mutations survive the tab closing.

**Entry condition: the identity boundary is set up.** A durable replica
belongs to exactly one resolved identity, and an identity change is a
reset, not a rebase (CONTEXT.md, "Identity boundary", #212). Give the
engine the signed-in principal's **identity fingerprint** (an opaque hash
of the session subject, never PII or a credential) through `Client.make`'s
`identity` option or the store's own option, and call `Client.reset` on
sign-in and sign-out. `BackgroundSync` requires the current fingerprint.
Do this phase last because it is the one where a mistake serves one user's
rows to the next user on a shared device.

**You'll know it's working when:**

- With the network off, a subscribed URL is still answered, with
  `x-legation-served-at`, and an unsubscribed one gets the façade's `503`
  JSON:API document with `code: "offline"`
  ([ADR-0029 §4](adr/0029-replica-served-jsonapi-facade.md)), not a failed
  fetch.
- Signing out and in as someone else on the same device shows none of the
  first user's rows. Their unpushed writes are quarantined, not pushed
  (`Client.quarantines`). Going from anonymous to signed in keeps the warm
  replica: it is the one benign transition.

**With effect-auth.** [`examples/audience`](../examples/audience) is the
whole chain for a signed-in app on effect-auth, headless and in one
process: `@thomasfosterau/legation-auth`'s `Resolver` turns the session
cookie into `SyncContext.identity` on both carriers (the sync protocol and
the derived REST handlers), `ReadScopes` compiles an effect-auth policy set
(owner, `public | followers | private`, a followers named set, a moderator
role) into each subscription's auth filter, and `SignOut.follow` resets the
replica when the session changes. Its tests assert on replica
contents: per-viewer replicas, a property test against effect-auth's own
per-row decision, façade/REST byte parity for a signed-in viewer, sign-out
on a shared device, and offline staying bounded.

## Reads that are never covered

Some reads will stay on the network whatever is subscribed, so plan for a
permanently mixed app. These are not gaps to work around. A request the
façade cannot cover is forwarded unchanged (online) or answered `503`
offline, and a `Client.query` it cannot cover falls through to the server's
read path ([ADR-0025](adr/0025-server-fallthrough-reads.md)). That
fallthrough is the intended answer for each of them.

| Read shape                                                | Why the replica cannot answer it                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full-text search, fuzzy or ranked matching                | Not expressible in the filter grammar ([ADR-0028](adr/0028-filter-grammar-and-normative-semantics.md)); the server's index ranks.                                        |
| Aggregate documents (`sitemap.xml`, `feed.json`, reports) | Not a JSON:API collection or resource the façade reflects; they are computed over everything, not a window.                                                              |
| Rendered artefacts (OG images, PDFs)                      | Not data reads at all.                                                                                                                                                   |
| Reads across a tenancy or identity boundary               | The replica holds only what this identity's auth filter admits; anything else is the server's to answer.                                                                 |
| A filter or sort the resource does not declare            | Refused before evaluation ([Trap 2](#trap-2-declare-what-may-be-filtered-and-sorted)).                                                                                   |
| A page deeper than the subscribed window                  | A windowed subscription covers only a prefix of itself ([ADR-0029 §3](adr/0029-replica-served-jsonapi-facade.md)); subscribe wider, or let deep pages go to the network. |
| An endpoint whose document carries app-specific `meta`    | The replica cannot compute it; keep that endpoint out of the api the façade reflects.                                                                                    |

## Caches: what to retire and what to keep

An app that already caches its API will have up to three layers. They are
not interchangeable with the replica, and an adopter that keeps or deletes
the wrong one either serves stale data or loses its edge performance.

| Cache                                                                                   | On adoption                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A client-side, URL-keyed read cache (IndexedDB, `localStorage`, a fetch wrapper's memo) | **Retire** it once its reads are subscribed.                                 | The replica replaces it outright: same rows, kept current by pulls and pokes, scoped to the identity (Phase 4). Two client caches disagree, and the URL-keyed one has no invalidation.                                                                                                                                                                                                 |
| The browser Cache API under the service worker                                          | **Keep** it behind the façade, for what the façade forwards.                 | The façade answers first; what it forwards can still be cached stale-while-revalidate (`CacheApiHttpCache`), evicted by `collection:{name}` tag as collections change (`HttpCacheInvalidation`).                                                                                                                                                                                       |
| Edge caches: a KV read-through cache, the Workers cache with `Cache-Tag` purges         | **Keep** them, and make them subscribers of the engine's invalidation hints. | They serve the reads that are never covered, and every first visit. `EdgeInvalidation` (`@thomasfosterau/legation-alchemy-cloudflare`, #206) turns each committed write's hints into KV deletes of `{collection}:{id}` and tag purges in the same `collection:{name}` / `collection:{name}:{id}` spelling; the API Worker forwards hints to the front-door Worker that owns the cache. |

## Trap 2: declare what may be filtered and sorted

A bridged node's **filterable set** is read off the resource's own
declarations ([ADR-0028](adr/0028-filter-grammar-and-normative-semantics.md)
rule d, #154). A resource that declares none has an almost empty set: `id`
and each to-one relationship's key field, by `eq` / `in` only, sortable by
`id` (`FilterPolicy.bareFor`, `FilterPolicy.keyDefaults`). Every other
filter or sort is refused before anything is evaluated:

- `Client.subscribe(url)` fails with a `QueryError` naming the field.
- The server refuses the subset with an `AuthorizationError`
  (`Authorization.checkFilterable`), before the backend sees it.
- The façade answers such a URL with the codec's `400`.

So a list page that filters by `status` and sorts by `-createdAt` silently
stays on the network, or fails to subscribe, until its resource says those
fields may be used. The fix is per model, on the resource definition that
the API and the bridge share:

```ts skip-type-checking
import { Schema } from "effect";
import { Filter, Relationship, Resource, Sort } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    // Piped declarations: filterable by eq / in, and sortable.
    status: Schema.String.pipe(Filter.able([Filter.Op.eq, Filter.Op.in]), Sort.able()),
    // Or the sugar of Resource.attribute: filterable by every operator, and sortable.
    createdAt: Resource.attribute(Schema.String, { filter: true, sort: true }),
  },
  relationships: {
    // A to-one relationship declares its filter on the relationship. The
    // bridge moves it onto the edge's key field (author → authorId).
    author: Relationship.one(() => Person, { filter: ["eq", "in"] }),
  },
});
```

`Resource.filterable(Article)` and `Resource.sortable(Article)` show what
the bridge will read. A literal kind that no schema can express, such as an
`instant` stored as an ISO string, is set through the bridge's
`filterable` override (`NodeBridge.FromResourceOptions`), which replaces
the resource's declaration for that field.

Declare only what the app's reads use. The filterable set is also what the
server will accept from any client, so it is part of the API's surface.
