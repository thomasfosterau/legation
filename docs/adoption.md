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

The server renders a page's data from a snapshot of the same sync
conversation the browser continues, so the first paint has data and the
browser's first pull continues from the server's cookie.

**Entry condition.** Phase 1's node graph, and a sync `Server` the
rendering process can reach: in-process, as the `ServerHandler` in
context, or over a `transport` (for example `BindingTransport` from
`@thomasfosterau/legation-cloudflare` for a separate API Worker).

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

## Phase 3: writes (not yet shipped)

Two paths will carry writes through the engine instead of around it:

- **Façade writes** (#169, [ADR-0030](adr/0030-facade-writes.md)): a
  plain-`fetch` `POST` / `PATCH` / `DELETE` on a reflected route.
- **Form-action Mutations** (#215): a SvelteKit form action that runs a
  named Mutation.

Neither is implemented yet, so this guide does not describe their
behaviour. Until they ship, writes go through the app's existing API as
before. Those writes are **out-of-band** for the engine: they bypass the
mutators, so they must announce themselves (`Server.broadcast`, or a hint
source, [ADR-0019](adr/0019-change-data-capture.md)) for subscribers to be
poked. Without that, subscribers converge only on their next pull.

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
