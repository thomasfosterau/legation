---
"@legation/effect": minor
---

Add **`SpecExport`**: emit OpenAPI 3.1 and AsyncAPI 3.0 descriptions of an app's
sync surface so bespoke clients can be generated in any language (ADR-0017). The
schema-defined protocol (push/pull/poke) is value-agnostic by design, so a
generic spec would describe an opaque envelope; `SpecExport` instead
**specializes** it from the app's own definitions — a `Mutation` variant per
mutator (its `args` schema), a patch `Put` per collection (its row schema), a
named subscription per query — so a generated client gets concrete, per-name
types instead of `any`.

The pipeline is two steps so new formats are cheap: `build(api)` produces a
format-neutral `SyncSpec` (a shared JSON-Schema component pool plus each
message's component name), and `toOpenApi` / `toAsyncApi` (or your own `toX`)
project it. `openApi(api)` / `asyncApi(api)` do both in one call. OpenAPI emits
push/pull as the logical `POST {path}/push` and `POST {path}/pull`; AsyncAPI adds
the streamed poke channel. The emitted schemas are the encoded (wire) form, and
the documents are plain JSON-serializable values. Needs nothing beyond `effect`,
so it lives in core (ADR-0006).
