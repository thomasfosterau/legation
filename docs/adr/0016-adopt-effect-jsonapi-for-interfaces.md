# ADR-0016: Adopt `@thomasfosterau/effect-jsonapi` for the JSON:API interfaces

Date: 2026-06-19
Status: Accepted; amended by issue #218

## Context

`@thomasfosterau/effect-sync-jsonapi` is a read-side collection loader: it maps
JSON:API v1.1 documents into engine collection rows (ADR-0008). To do that it
carried its own hand-rolled copies of the JSON:API wire surface — the link,
resource-identifier, relationship, error, and document `Schema` codecs in
`schema.ts`, plus an ad-hoc `sort`/`page` query-string builder. These
duplicated the spec and could drift from it.

A dedicated, spec-compliant library — `@thomasfosterau/effect-jsonapi` —
now models JSON:API v1.1 on Effect's `Schema` (a `Document` module of
spec primitives, a `Query` module of typed query parameters). Maintaining a
parallel, less-complete copy of the same spec is exactly the kind of
duplication ADR-0006 draws package boundaries to avoid: the JSON:API protocol
surface is a dependency, so it belongs behind a package, not re-implemented.

The library is resource-first: its `Document.DataDocument` / `CollectionDocument`
and its `Query.schema` are parameterized by a known `Resource` definition. This
loader is the opposite — it decodes documents whose `type` and attribute shapes
it does not know ahead of time. So the library is a fit for the _primitives_,
but a resource-agnostic document schema must still sit on top of them.

## Decision

Depend on `@thomasfosterau/effect-jsonapi` and adopt it for the JSON:API
**interfaces** the loader consumes:

- **Wire types & schemas.** `schema.ts` builds its generic `ResourceObject` /
  `Relationship` / `JsonApiDocument` codecs on the library's `Document`
  primitives — `Document.AnyMeta`, `Document.Link` / `LinkObject`,
  `Document.ErrorObject`, `Document.JsonApiObject` — instead of hand-rolled
  duplicates. The generic, untyped composites stay local because the library
  has no resource-agnostic equivalent; they just no longer redefine the spec
  primitives.
- **Query encoding.** Sort serialization goes through the library's
  `Query.Sort` codec (the spec's `-field,field` descending-prefix convention by
  construction), and `JsonApiRequestOptions.page` adopts the `Query.Page`
  strategy vocabulary (offset/limit, number/size, cursor/size). Filtering and
  `include` stay generic: the spec leaves filter semantics implementation-
  defined (the library agrees), and the library's typed `Include` / `Fieldset`
  encoders require a `Resource` this loader does not have.

The library's peer dependency is `effect >= 4.0.0-beta.84`, so the workspace
catalog was bumped from `beta.83` to `beta.84` package-wide (ADR-0003).

## Consequences

- The JSON:API spec surface has a single, spec-compliant source of truth; this
  package no longer drifts from it.
- A new external dependency is confined to `@thomasfosterau/effect-sync-jsonapi`,
  consistent with ADR-0006 (protocol/library dependencies live in their own
  package, never in core).
- The adopted `Document`/`Query` modules depend only on `effect`'s `Schema`,
  not on `effect/unstable/httpapi`, so the adoption adds no new double-beta
  unstable surface beyond what the package already used.
- The public `JsonApiError` type is now the library's `Document.ErrorObject`
  shape (e.g. `source` is a `{pointer} | {parameter} | {header}` union), which
  is stricter and more spec-correct than the previous permissive struct.
- `JsonApiRequestOptions.sort` changed from `string[]` (pre-encoded
  `-field` strings) to the library's `{ field, direction }` term shape; the
  loader encodes it to the wire form. This is the one breaking change to the
  package's surface.
- If a future need arises to derive sync from typed `Resource` / `Group` /
  `Endpoint` definitions (rather than reflecting an arbitrary `HttpApi` by path
  convention, per `Convention.ts`), the library is already a dependency — that
  is a separate, larger decision left open here.

## Amendment (#218): this ADR never adopted a filter grammar

Recorded because `CONTEXT.md` came to describe `Predicate` as "the engine
form of the filter grammar" and credited this ADR with a shared language it
never decided. The record above already says otherwise — "Filtering ...
stay[s] generic: the spec leaves filter semantics implementation-defined
... and the library's typed `Include` / `Fieldset` encoders require a
`Resource` this loader does not have" — but nothing here ruled the point
out explicitly, so the glossary drifted into over-claiming it.

To be unambiguous: this ADR adopts effect-jsonapi's wire **primitives**
(`Document`, `Query.Sort`, `Query.Page`) for the resource-agnostic loader.
It adopts nothing about filtering. `Predicate` — legation's own subset
language, used in subscriptions, evaluated with Postgres-normative
semantics (ADR-0028) — is not a form of effect-jsonapi's filter grammar (a
query-parameter format, decoded from untrusted URLs, canonically encoded
for `self` links) and was never meant to be one. Where the two meet is
`@thomasfosterau/legation-jsonapi`'s façade-boundary bridge (`JsonApiQuery.fromFilterAst` /
`toFilterAst`, ADR-0029 §6) — a projection for one job, not a claim that
either language is the other's internal form.
