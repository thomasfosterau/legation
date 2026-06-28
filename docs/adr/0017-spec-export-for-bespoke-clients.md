# ADR-0017: Spec export for bespoke clients

Date: 2026-06-28

Status: Accepted

## Context

The sync protocol is schema-defined (ADR-0008): push/pull/poke messages and
patch operations are Effect `Schema` codecs (Protocol.ts), carried over a
pluggable transport with the RPC implementation as default (ADR-0002,
ADR-0007). The reference clients are the Web/Effect stack and — for record — the
withdrawn native ports (ADR-0012, ADR-0013). Consumers on other platforms, or
who want a thin generated client rather than the full engine, have no
machine-readable description of the surface to generate against. The schemas
exist in TypeScript; nothing projects them into the lingua franca of client
codegen — OpenAPI, AsyncAPI, JSON Schema.

The hard part is not the document envelope; it is **specialization**. The wire
protocol is value-agnostic by design (ADR-0002): `Mutation.args`, `PatchOp.Put.value`
and a named subscription's `args` are `unknown`. A spec built from the raw
protocol describes an opaque envelope — a generated client would type every
payload as `any`. What makes a client _bespoke_ is narrowing those holes to the
app's actual collections, mutators and queries.

Effect provides the primitives: `Schema.toJsonSchemaDocument` emits the
**encoded** (wire) form of a codec, `SchemaRepresentation.fromASTs` pools many
roots into one shared definitions set, and `JsonSchema.toMultiDocumentOpenApi3_1`
rewrites refs to `#/components/schemas/...`. No dependency beyond `effect` is
needed, so by the mechanical test of ADR-0006 this is **core**, not a new
package.

## Decision

Add a `SpecExport` module to `effect-sync-core` that turns an app's sync surface
into format-neutral intermediate representation, then projects it to concrete
documents.

- **Specialize, don't describe the envelope.** From the app's collections,
  mutators and queries, build narrowed schemas: a `Mutation` discriminated union
  with one variant per mutator (`mutator` literal + that mutator's `args`
  schema), a `PatchOp` with one `Put` variant per collection (its row schema),
  and a `NamedSubscription` union with one variant per query. Where the app
  supplies nothing, the generic protocol schema stands in, so a read-only or
  write-only app still yields a valid spec.

- **Two-step pipeline for extensibility.** `build(api)` produces a
  format-neutral `SyncSpec` — a shared JSON-Schema component pool plus the
  component name of each message and app type. Emitters (`toOpenApi`,
  `toAsyncApi`, or a consumer's own) project that IR. Adding "any other format"
  is adding a `toX(spec)`, not re-deriving the schemas.

- **OpenAPI is the protocol's logical REST projection.** Push and pull are
  emitted as `POST {path}/push` and `POST {path}/pull` — the codegen-friendly
  shape every OpenAPI generator handles well. The default RPC carrier
  multiplexes both over one endpoint with its own envelope; the projection is the
  contract a bespoke client (or a thin REST adapter) speaks, documented as such
  in the emitted `info.description`.

- **AsyncAPI carries the streaming view.** Push/pull as request-reply send
  operations and the contentless poke hint as a receive channel, sharing the same
  component pool. The streamed poke (a latency optimization, never a correctness
  dependency — CONTEXT.md) belongs in the message-oriented format, not OpenAPI.

The encoded (wire) form is what is emitted throughout, so the spec matches what
crosses the wire, not the in-memory decoded types.

## Consequences

- A bespoke client in any language can be generated with concrete per-name types
  for rows, mutator args and query args, instead of an opaque envelope. The
  emitted documents are plain JSON-serializable values; callers serialize to
  JSON/YAML as they wish.

- The spec is a projection, not a second source of truth: it is derived from the
  same protocol and app schemas the engine runs on, so it cannot drift. A
  protocol or collection change re-emits a changed spec.

- The OpenAPI document describes a logical projection, not the byte-level RPC
  framing. A generated REST client needs a server exposing that projection
  (trivially layered over the node adapter or a custom handler); this is a
  documentation point, called out in the emitted description.

- JSON Schema generation is best-effort (Effect's own caveat): schema semantics
  with no JSON Schema equivalent are approximated. The protocol messages and
  typical row/args schemas stay within the representable subset.

- New formats are additive and cost a single `toX(spec)` over the shared IR; they
  need no change to the specialization logic.
