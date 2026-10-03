---
"@thomasfosterau/legation-jsonapi": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-effect": minor
---

The JSON:API façade (ADR-0029, issue #166): a fetch handler that answers a
covered JSON:API `GET` from the replica and stays out of the way otherwise.

- `JsonApiFacade.fetchHandler({ nodes, api, view, coverageOf, cookie?, resources?, baseUrl?, prefix?, online? })`
  in `@thomasfosterau/legation-jsonapi` builds the façade from the app's `HttpApi`
  (`Convention.reflectResources` gives the `list` / `getOne` routes it
  recognises; those whose type is no node are left to the server), the
  node graph, the replica's view and a coverage source. It presumes the
  api's read endpoints are declared with the graph's codec
  (`JsonApiQuery.querySchema` / `singleRowSchema`) and served by the
  derived handlers, which is what lets a parse failure be answered locally.
  `matches(request)` says whether a request is its business — a `GET` whose
  `Accept` names `application/vnd.api+json` on a reflected route under
  `baseUrl` — and `handle(request)` answers: a covered request gets `200`
  with the document the one writer produces (byte-equal in content to the
  derived REST handler's for the same declarations, the optimistic overlay
  visible as `Client.query` sees it), `Cache-Control: no-store` and
  `x-legation-served-at` set to the replica's CVR cookie (the store's,
  empty until the first pull); a URL the grammar rejects gets the codec's
  `400` document (`RestHandlers.queryErrorDocument`), except an `include`
  the graph does not declare, which the server rules on; an uncovered
  request while offline gets the `503` `offline` error document of
  ADR-0029 §4 (`handler.offline`, with the cookie, also for a forward that
  rejected at the transport). Everything else is `undefined` for the caller
  to forward unchanged: a non-candidate, an uncovered request while online,
  a collection no bound resource declares, and a single-resource request
  whose row the replica does not hold (the 404 is the endpoint's own).
  Coverage is every read `ReplicaDocuments.toCover` names, each judged by
  `coverageOf` — `client.coverageOf`, or the host's registrations below.
  The module lives in `@thomasfosterau/legation-jsonapi` by ADR-0006: it needs this
  package's codec, writer and route reflection plus the standard
  `Request` / `Response` globals, and `navigator.onLine` is an option with a
  guarded default, so `@thomasfosterau/legation-browser` stays free of effect-jsonapi.
- `EngineHost.run` returns a `Host` whose `registrations` lists what the
  host holds on its mirrors' behalf — root windows, relational registrations
  with their edge selects, both halves of a `SubscribeUrl` with its canonical
  URL while a party holds it by URL — as `Coverage.Subscription`s: the
  ledger a façade's coverage check scans in a worker, where no `Client`'s
  own ledger sees the tabs' pins. A registration is listed once its engine
  registration exists (a relational one once its reconcile loop has
  started; one naming an edge the registry does not declare registers
  nothing) and dropped when the last mirror releases it or is swept.
  `Coverage.verdictOf` and
  `Coverage.coverageOf(nodes, subscriptions)` give the same `Verdict` as
  `Client.coverageOf` over any such ledger; `Client` uses the former.
- `ServiceWorkerHost.start` serves exactly as `run` does and returns the
  `Host` — the engine and its registrations — for the worker to build the
  façade from; `run` is `start` then serve forever.
- The commerce worker composes façade, then its unchanged HTTP cache, then
  the network (`examples/commerce/src/service-worker.ts`,
  `src/lib/facade.ts`, `src/lib/host.ts`); the api's shape moves to
  `server/api.ts` so the worker reflects the routes the server serves; and
  the replica test runs the façade over the same seed: every URL the
  shell's pins cover is answered with the served document's bytes, and the
  rest go to the network. `Convention.segmentsOf` and `Convention.isParam`
  are exported.
