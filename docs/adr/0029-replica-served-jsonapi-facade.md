# ADR-0029: A replica-served JSON:API façade in the service worker

Date: 2026-09-03
Status: Accepted (issue #157; supersedes ADR-0025's coverage rule)

## Context

ADR-0010 and ADR-0021 define one browser client shape. The engine lives in
the service worker. Tabs are mirrors over a BroadcastChannel, and they speak
`Query.Read` through a `Client`. Every read the app makes goes through that
object, and every subscription is a compiled root window in its ledger.

A second client shape is wanted (#149): plain `fetch()` of a JSON:API URL,
answered from the replica when the replica holds the rows. The commerce
example already has the audience. Its no-JS baseline, its SSR loaders and
any third-party widget speak JSON:API against `/jsonapi/...` and never touch
a `Client`. Today those requests always cross the network, and offline they
fail, even when the worker beside them holds every row they asked for.

ADR-0028 removed the blocker. There is now one filter grammar for REST URLs
and sync predicates, with one normative semantics. A URL can be translated
to a `Query.Read` (#161), evaluated over the replica, and serialised back to
a document that the server would have produced. Without that, a façade would
have answered the same URL differently from the server.

Two things are undecided and this ADR records them.

**Topology.** Where the façade sits relative to the mirror, the owned engine
and the HTTP cache (`CacheApiHttpCache`,
`packages/browser/src/CacheApiHttpCache.ts`), and how it recognises a
JSON:API request.

**Coverage.** ADR-0025 defined coverage as an exact hash match in the
Client's ledger: `Client.query` answers locally iff `Subset.hash(root)` is a
ledger key (`packages/effect/src/Client.ts`, `queryOnce`). It said "no
subsumption ... left as a future refinement". For the mirror a false
negative costs one round trip. For the façade it decides whether
`GET /products?filter[categoryId]=c-audio` is served offline when the app
subscribed to `GET /products`. The refinement is due now.

What exists today, for the record:

- The ledger is keyed by `Subset.hash`, which is `JSON.stringify` of the
  subset. `Client.subscribe(read)` pins the compiled root window and nothing
  else. Edge windows register only through `observe` and the `Related`
  reconcile loop (`packages/effect/src/Related.ts`, `desiredSubsets`).
- `Convention.reflectResources` (`packages/jsonapi/src/Convention.ts`)
  classifies an `HttpApi`'s endpoints into `list` and `getOne` routes by
  method and path shape, prefix ignored.
- The worker's fetch listener (`examples/commerce/src/service-worker.ts`)
  returns early on non-`GET` and on paths without a cache policy, then runs
  the stale-while-revalidate handler. Sync traffic passes straight through.
- The commerce shell pins
  `{ collection: "products", order: ["id"], first: 100 }` and four whole
  collections at boot (`examples/commerce/src/lib/domain.ts`, `shellReads`).
  `productPage` reads twelve products by `id`, optionally filtered by
  `categoryId`.

Decisions taken in #149 and not reopened here: subscriptions are explicit;
no auto-subscribe on fetch and no expiry policy; coverage is conjunct
subsumption with strict windows; full implication is an aspiration with a
named trigger; uncovered goes to the network unchanged; offline and
uncovered returns a JSON:API error document with 503; the store holds full
resources and `fields[]` is a projection; same URL, same result as the
derived REST handler; writes are out of scope; no dataflow engine
(ADR-0027 §4); no relationship traversal in the grammar (ADR-0028); the
mirror stays.

## Decision

### 1. Topology: a third front over one engine

The façade is a **third front over the same `ClientEngine`**, beside the
mirror (`Client.connect`) and the owned engine (`Client.make`). It adds no
engine, no store and no sync loop. It is a fetch handler in
`@legation/browser` (#166) that the app's service worker composes into its
`fetch` listener.

```
        tab (UI)                          service worker host
┌────────────────────────┐        ┌──────────────────────────────────┐
│ Client.connect (mirror)│◀──────▶│ ClientEngine                     │
│ live queries           │ b'cast │  ledger, replica, journal        │
├────────────────────────┤        │  ▲                               │
│ plain fetch()          │───────▶│ JSON:API façade ── covered? ─yes─┤ (replica)
│ GET /jsonapi/products  │◀───────│      │ no                        │
└────────────────────────┘        │      ▼                           │
                                  │ HTTP cache (CacheApiHttpCache)   │
                                  │      │                           │
                                  └──────┼───────────────────────────┘
                                         ▼ network, request unchanged
```

**Route recognition.** The handler is built from the app's `HttpApi`. It
calls `Convention.reflectResources` and keeps the `list` and `getOne`
routes. A request is a candidate iff its method is `GET`, its `Accept`
includes `application/vnd.api+json`, and its path matches one of those route
templates. Everything else is not the façade's business and passes through
untouched. No per-endpoint annotation is required, matching the convention
`@legation/jsonapi` already uses for loaders.

**Composition order.** In the worker the façade runs **first**, then the
HTTP cache, then the network. The cache must not see a covered request: a
cached copy of a locally answerable document would be a second, staler
source of truth. An uncovered request falls out of the façade into whatever
the app composes next, exactly as it does today.

**Parsing.** A candidate URL is decoded with the effect-jsonapi codec
(thomasfosterau/effect-jsonapi#86) and bridged to a `Query.Read` (#161). A
parse failure returns the 400 error document the codec produces. The server
would reject the same URL identically, so answering it locally is not a
divergence. An include path the node graph does not declare is not a parse
failure; it falls through to the network, where the server rules on it.

### 2. Subscriptions are explicit

The replica is subscription-defined (ADR-0025). The façade does not change
that. **A request is served locally only when an explicit subscription
covers it.** The façade never registers a subscription because a request
arrived, and it never lets one lapse because requests stopped. There is no
auto-subscribe on fetch and no expiry policy.

The app declares interest with `Client.subscribe(url)` (#159), the URL
overload of today's `Client.subscribe(read)`. The URL is parsed the same
way the façade parses a request, then canonicalised. **Canonical URL
identity comes from effect-jsonapi's canonical encoder**
(thomasfosterau/effect-jsonapi#85). That issue is open as of today and
effect-jsonapi 0.12.0 does not carry it; #159 and #166 depend on it. The
ledger keys the subscription by that one string, beside the subset hash, so
`subscribe(url)` and `subscribe(read)` for the same query produce one entry.
Refcounting is unchanged: subscriptions remain client state, refcounted per
mirror by the host (ADR-0021).

A covering subscription must also declare any `include` edges the requests
will ask for, because edge selects are what register the foreign windows
(section 3). An explicit subscription therefore pins its edge windows, not
only its root window. Today `Client.subscribe(read)` pins the root alone;
#159 extends it to run the same `Related` registration `observe` runs.

Why explicit: the alternative, subscribing on first fetch, would make the
replica's shape a function of traffic. Which URLs the page happened to
request would decide what syncs, what the CVR tracks and what the server
pays for. Subscriptions are an app decision and stay one.

### 3. Coverage rule 2: conjunct subsumption with strict windows

This section supersedes "Coverage is the Client's own ledger" in ADR-0025.
The rule is implemented as `Coverage.covers(subscribed, requested)` in
`@legation/effect` (#162), and `Client.query` uses it for the mirror and
the owned engine as well as for the façade. The statement here and the
implementation must match exactly.

**The rule.** `Coverage.covers(subscribed, requested)` is a pure function of
two compiled root windows (`Subset`s). A request is served locally iff some
subscription in the ledger covers it. A subscription covers a request iff
all of the following hold.

1. **Collection.** `subscribed.collection === requested.collection`.
2. **Window.** A subset is _windowed_ when it has a `limit` or a `cursor`
   (`Query.plan` emits a cursor without a limit for `{ after }`, and
   `Subset.window` applies it regardless). Either the subscription is
   unwindowed, or all three of: `subscribed.orderBy` deep-equals
   `requested.orderBy`; `requested.cursor === subscribed.cursor`; and, when
   the subscription has a `limit`, `requested.limit <= subscribed.limit`.
   Anything else is not covered. In particular a windowed subscription
   never covers an unwindowed request, a request with a different sort, or
   a request with a different cursor, and a limited subscription never
   covers an unlimited request.
3. **Predicate.** Canonicalise both predicates to a set of top-level
   conjuncts: flatten nested `And`, then sort the conjuncts structurally.
   An absent `where`, `True`, and an empty `And` all canonicalise to the
   empty set. The subscription covers iff its set is a subset of the
   request's set under structural equality of `Compare`, `In`, `NotIn` and
   `IsNull` nodes (same operator, same field, same typed literal; literal
   lists in canonical order). `Or` and `Not` subtrees compare only by
   structural equality as whole conjuncts; nothing is inferred through
   them. A `True` subscription (empty set) covers any predicate on that
   collection, subject to rule 2. **Under a windowed subscription the two
   sets must be equal**, not merely in the subset relation: a narrower
   predicate over a window may need rows past its edge (the second worked
   table below, and "Why rule 2 is strict").
4. **Include.** Each edge the request includes must be present in the
   covering subscription's edge selects, because those selects registered
   the foreign windows (ADR-0024, `Related.desiredSubsets`). For a
   paginated edge the same strictness as rule 2 applies per edge: the
   request's `first` is at most the subscription's, or the subscription's
   select is unwindowed. Edge order is declared by the edge, so it never
   differs.

`fields[]` on the request never changes what is covered; it is a projection
(section 5).

**Why rule 2 is strict.** A windowed subscription holds the first N rows
of _its_ order, and nothing else is promised to be in the replica. A
request with a narrower predicate over that window may need rows beyond N
that were never synced: the first twelve audio products may all sit past
the hundredth product by name. `ORDER BY ... LIMIT` over a partial replica
is not locally maintainable, so a window covers only a shorter prefix of
the identical order from the identical cursor. Widening a window is a
subscription change (ADR-0024's "load more is a wider window"), not a
coverage question.

**Why rule 3 is sound.** Every row the request wants satisfies all of the
request's conjuncts, hence all of the subscription's conjuncts, hence is
in the replica. The request's extra conjuncts filter locally over rows the
replica already holds. That is ADR-0027's two-tier rule seen from the
other side: local filtering never widens sync, and here it never needs to,
because the subscription is a superset by construction. Structural
equality keeps the check syntactic and total; no evaluator runs at
coverage time, so the check cannot disagree with ADR-0028's semantics.

**Rule 3, full implication, is an aspiration.** A semantic check
(`lt("price", 10)` is implied by `lt("price", 20)`; `In` on a superset list;
an `Or` of covered branches) would cover more requests. It is not built.
The trigger for building it is **a real app subscription pattern the
syntactic check misses**: an example app or a user report whose
subscriptions are right and whose requests still go to the network because
subsumption is not syntactic. The first candidate is already visible:
`GET /products/p-1` against a windowed products subscription is a network
request under rule 2, even though a single row by id needs no window. Until
a pattern like that is real, the cost of a false negative is one round trip
(section 4), and the rule stays syntactic.

#### Worked example: an unwindowed subscription

The app subscribed to `GET /products?include=variants` (unwindowed, no
filter, the `variants` edge selected). Six candidate requests:

| #   | Request                                    | Verdict | Reason                                                                             |
| --- | ------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| 1   | `GET /products`                            | local   | Same collection, empty conjunct set, no window                                     |
| 2   | `GET /products?filter[categoryId]=c-audio` | local   | Extra conjunct filters locally; every audio product is in the replica              |
| 3   | `GET /products?sort=name&page[limit]=12`   | local   | Unwindowed subscription covers any window: all rows present, sort and limit local  |
| 4   | `GET /products?include=variants,reviews`   | network | `reviews` edge not registered by the subscription                                  |
| 5   | `GET /products/p-1`                        | local   | A get is `filter[id]=p-1`, first 1; the conjunct filters locally, the window is ok |
| 6   | `GET /categories`                          | network | Different collection                                                               |

#### Worked example: a windowed subscription

The app subscribed to `GET /products?sort=name&page[limit]=100` (the first
hundred by name, no filter). Three candidate requests:

| #   | Request                                                             | Verdict | Reason                                                                        |
| --- | ------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| 1   | `GET /products?sort=name&page[limit]=12`                            | local   | Same sort, same (absent) cursor, smaller limit: a prefix of the synced window |
| 2   | `GET /products?filter[categoryId]=c-audio&sort=name&page[limit]=12` | network | Strict window: the first 12 audio products may lie beyond the 100 synced      |
| 3   | `GET /products?sort=-name&page[limit]=12`                           | network | Different sort; the synced prefix is of another order                         |

This second table is what #162's acceptance criterion about the commerce
`productPage` read asserts. The commerce shell pins
`{ collection: "products", order: ["id"], first: 100 }`, so its rows read
with `sort=id`: `productPage({})` is row 1 and served locally;
`productPage({ categoryId })` is row 2 and falls through. The verdicts do
not depend on which field the order names.

### 4. Uncovered requests go to the network unchanged; offline returns 503

An uncovered candidate request is forwarded exactly as received: same URL,
same headers, same body. The façade adds nothing and rewrites nothing, so
the server sees the request the app wrote. Whatever the app composes after
the façade (the HTTP cache, then `fetch`) handles it.

**Offline** means the network is unreachable: `navigator.onLine` is
`false`, or the forwarded `fetch` rejected at the transport. A status code
from the server is never offline. An uncovered request that meets either
condition returns a spec-compliant JSON:API error document with status
**503**:

```json
{
  "errors": [
    {
      "status": "503",
      "code": "offline",
      "title": "Service unavailable",
      "detail": "The request is not covered by a local subscription and the network is unreachable."
    }
  ]
}
```

with `Content-Type: application/vnd.api+json`. A covered request is never
affected by connectivity.

**Locally served responses** carry:

- `x-legation-served-at: <cookie>`, a non-spec header whose value is the
  replica's CVR cookie at the time of the answer. Devtools and tests use it
  to tell a local answer from a network one and to know which replica state
  produced it. Which subscription covered the request is recorded beside it
  (#162, for devtools).
- `Cache-Control: no-store`. The replica is the cache; a second copy in the
  HTTP cache or the browser's cache would be stale on the next pull.

**The optimistic overlay.** A covered response sees pending optimistic
mutations exactly as `Client.query` does for covered reads. An uncovered
network response does not; it is the server's authoritative answer, as in
ADR-0025's authoritative-only tier. This asymmetry is documented, not
hidden: an app that needs optimistic visibility in a plain-fetch read keeps
that read within covered windows, as it would with `Client.query`.

### 5. Full resources in the store; `fields[]` is a projection

The local store holds **full resources**, one per row, as the sync tier
ships them. A request's `fields[type]` is applied at serialisation in the
worker (#164) and only there. A sparse response is never written back to
the store, whether it came from the network or was produced locally.
Coverage ignores `fields[]` entirely (section 3).

Two consequences fall out. A subscription
`GET /products?fields[products]=name` syncs full product rows; the
projection is a display choice, not a sync choice, consistent with
ADR-0027 §3. And two requests differing only in `fields[]` are answered
from the same rows with the same cookie.

### 6. Same URL, same result

A locally served document must match what the derived REST handler (#163)
returns for the same URL **byte-for-byte on document content**, ignoring
the host in `links.self`. That is the whole point of one grammar. Both
sides serialise through one rows-to-document function (#164): `include`
into `included`, `fields[]` projection, `sort` and `page` from the same
`Subset.comparator` and window semantics, `links.self` and pagination links
from the canonical encoder. The evaluators underneath agree by ADR-0028's
differential harness; the serialisers agree by a differential test over the
commerce corpus (#168) that runs each URL through both and compares.

Where they may differ: response headers (section 4's two headers, and the
server's own), and the host in `links.self`. Nothing else.

### 7. Writes are out of scope

The façade intercepts `GET` only. `POST`, `PATCH` and `DELETE` pass through
to the network unchanged, journal untouched. Offline writes through the
façade, their response synthesis and their rejection surfacing are #150's
design (W1, #169). Nothing in this ADR presumes a shape for them beyond
"the journal stays the outbox".

## Consequences

- **`Client.query`'s coverage check changes for every front.** #162
  replaces the `Subset.hash` lookup in `queryOnce` with `covers` across the
  ledger, so the mirror and the owned engine gain subsumption too. A
  `Client.query` for `productPage({ categoryId })` under an unwindowed
  products subscription now answers locally instead of falling through.
- **Cost is O(#subscriptions) per read**, each check a small structural
  comparison. The examples hold at most ten subscriptions; a ledger index
  by collection is the obvious refinement if a real app holds hundreds.
- **A false negative costs one round trip and never wrong data.** The
  answer that comes back is the server's, which ADR-0025 already treats as
  the more authoritative one. A false positive is impossible by rule 3's
  soundness argument and rule 2's strictness.
- **The "same URL, same result" obligation binds #163 and #164.** Neither
  ships a serialiser of its own; both call the one function, and #168's
  differential test is a gate on both. A byte difference on document
  content is a bug in whichever side diverged from the grammar.
- **The header is the observability seam.** `x-legation-served-at` lets
  the commerce tests (#168) assert "served locally at cookie X" without
  reaching into the worker, and lets devtools show which requests the
  replica absorbed.
- **The explicit-subscription trade.** An app that forgets to subscribe
  gets network behaviour for that URL, never wrong data and never a silent
  local miss. An app that subscribes too widely syncs more than it shows,
  which is the same trade `Client.subscribe(read)` already makes. Traffic
  never shapes the replica.
- **`Client.subscribe(read)` grows edge pinning.** An explicit
  subscription with `include` must register the edge windows it declares,
  or rule 4 could never hold. #159 carries this change; it is a behaviour
  change for the mirror as well.
- **Composition order is the app's responsibility.** The worker composes
  façade, then cache, then network; the commerce service worker is the
  reference. A worker that puts the cache first serves stale documents for
  covered URLs, which the header makes visible in tests.
- **Dependencies.** #159 and #166 wait on thomasfosterau/effect-jsonapi#85
  (canonical encoder) and #86 (codec); #162 waits on #155 for the canonical
  predicate shape (`IsNull`, `NotIn`); #164 and #168 wait on #163.
- **ADR-0025 is superseded in part.** Its Status line and its "Coverage is
  the Client's own ledger" section now point here. Its body is otherwise
  untouched: the `read` wire operation, the two-phase include, the
  authoritative-only tier and the hosted composition all stand.
- **CONTEXT.md and the README are updated.** The Client entry lists the
  façade as a third place a read is answered; **Coverage** and **Façade**
  enter the glossary; the topology diagram shows the third front.
- **No changeset accompanies this ADR.** ADR-only commits carry none in
  this repository; #159, #162, #164, #166 and #168 carry their own.

## Amendment (#166): where the façade lives and what it consults

Recorded when the handler shipped; the decisions above stand.

- **Placement.** Section 1 says "a fetch handler in `@legation/browser`".
  It shipped as `JsonApiFacade.fetchHandler` in **`@legation/jsonapi`**, by
  ADR-0006's rule: every dependency it has is that package's (route
  reflection, the codec, the writer) plus the standard `Request` /
  `Response` globals, and its one browser-only reading, `navigator.onLine`,
  is an option with a guarded default. `@legation/browser` stays free of
  effect-jsonapi; it contributes `ServiceWorkerHost.start`, which returns
  what the worker's façade needs from the host.
- **The ledger it consults.** In the service-worker topology no `Client`
  ledger in the worker sees the tabs' pins; the `EngineHost` does. It now
  records what it registers with the engine on the mirrors' behalf (root
  windows, relational registrations with their edge selects, both halves of
  a `SubscribeUrl` with its canonical URL) and returns them as
  `Host.registrations`; `Coverage.coverageOf(nodes, host.registrations)` is
  the façade's coverage check there, the same rule and the same `Verdict`
  as `Client.coverageOf`. A registration is listed once its engine
  registration exists and dropped when the last mirror releases it or is
  swept, so a read judged covered is one whose rows the engine syncs. A
  URL identity is known to the host only for `SubscribeUrl`; a connected
  Client's `subscribe(url)` arrives as `Subscribe` / `SubscribeRelated`,
  and its URL stays in that Client's ledger.
- **`x-legation-served-at`** carries the client store's pull cookie
  (`ClientStore.getCookie`), which is the replica's CVR cookie; the engine
  itself does not expose it, so the façade takes it as an option. It is
  empty until the first pull. The façade sets the header, with
  `Cache-Control: no-store`, on every response it synthesises — the 400 and
  503 documents included — so any local answer is distinguishable from a
  network one.
- **Two forwards section 1 did not name.** A single-resource request whose
  row a covered replica does not hold is forwarded: the 404 is the
  endpoint's own error class, which only the server writes. And a `GET`
  whose `Accept` does not name `application/vnd.api+json` — `*/*` included
  — is not a candidate, per section 1's wording.
- **Composition in the commerce worker.** Façade, then the HTTP cache
  (under its unchanged policy), then the network; a candidate whose forward
  rejects at the transport becomes the 503 document in the worker
  (`JsonApiFacade.offlineResponse`). The worker's routes are the server's
  read routes restated in `src/lib/facade.ts`, because the server's api
  module pulls in the SQL runtime and cannot load in a worker.
