---
"@thomasfosterau/legation-jsonapi": minor
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
  synthetic resources (`JsonApiQuery.resourcesOf(nodes)`). Parity holds when
  the endpoint is declared with the node-derived codec
  (`JsonApiQuery.querySchema`) and collection edges are `many`; an `include`
  edge or a `fields[type]` type the bound resource does not declare is
  refused with the codec's `QueryError` shape before any query runs.
  `toCover(read)` names the reads a request needs covered for its document
  to be faithful: the read itself, plus one whole-collection read per
  collection the declared linkage resolves from beyond the read's includes;
  the caller (the façade) serves a URL only when every one is covered
  (`Client.coverageOf`). A collection no bound resource declares is a
  `QueryError` from every entry point, never a defect. The module depends on
  nothing but `effect` and the engine, so it runs in a service worker.
- `RestHandlers` derives its linkage through the same package-internal
  derivation the replica-side writer uses (what a document's relationships
  are resolved from beside the URL's includes, over any row source); its
  behaviour is unchanged.
- `JsonApiQuery.parseRead` reports the row id a `/{type}/{id}` path
  addressed (`ParsedRead.id`), so a caller knows to write a single-resource
  document. `JsonApiQuery.invalidParameter` builds the `QueryError` shape
  the codec's checks raise.
- The commerce example checks every read `src/lib/domain.ts` declares
  against the same seed on both sides, byte for byte
  (`examples/commerce/tests/replica-documents.test.ts`).
