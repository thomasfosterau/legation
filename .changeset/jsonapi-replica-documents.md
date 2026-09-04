---
"@legation/jsonapi": minor
---

Compound documents from the replica (#164): the worker-side caller of the one
serialiser, so the same URL yields the same document content from the
replica as from the derived REST handler (ADR-0029 §6).

- `ReplicaDocuments.make({ nodes, resources?, prefix? })` binds the
  replica-side writer. `fromUrl(view, url)` parses a URL through
  `JsonApiQuery.parseRead` (the read and its `fields[]` projection together),
  runs it over a local view — the replica's rows, optimistic overlay
  included, through the two-phase include with the plan's edge windows — and
  writes a single-resource document for `/{type}/{id}` (`data: null` when
  the replica holds no row) or a collection document otherwise, through
  `DocumentWriter`; `collection(view, parsed)` and `data(view, parsed)` take
  a parsed read. Linkage follows the resource declarations it is given —
  the resources the REST endpoints are declared with, so both sides emit the
  same relationships by construction — or, without any, the node graph's
  synthetic resources (`JsonApiQuery.resourcesOf(nodes)`). `toCover(read)`
  names the reads a request needs covered for its document to be faithful:
  the read itself, plus one whole-collection read per collection the
  declared linkage resolves from beyond the read's includes; the caller
  (the façade) serves a URL only when every one is covered
  (`Client.coverageOf`). The module depends on nothing but `effect` and the
  engine, so it runs in a service worker.
- `Linkage` is the shared derivation of what a document's relationships are
  resolved from beside the URL's includes — the resource's declared `many`
  relationships on the primary and on each included resource — with
  `Linkage.resolve(fetch, …)` running the read and the included resources'
  linkage batch over any row source: `SyncServer.readSubsets` on the REST
  side, the local view on the replica side. `RestHandlers` now derives its
  linkage through it; its behaviour is unchanged.
- `DocumentWriter.Input.shape` selects how rows carry their linkage:
  `nodeRows` (the default — a `one` edge's key in its `via` field) or
  `jsonApiRows` (`Derive`'s `JsonApiRow`: identifiers under
  `relationships[name]`, so a `many` edge the read did not resolve still
  links through the identifiers the row holds). Attributes need no
  strategy: both shapes flatten them.
- `JsonApiQuery.parseRead` reports the row id a `/{type}/{id}` path
  addressed (`ParsedRead.id`), so a caller knows to write a single-resource
  document.
- The commerce example checks every read `src/lib/domain.ts` declares
  against the same seed on both sides, byte for byte
  (`examples/commerce/tests/replica-documents.test.ts`).
