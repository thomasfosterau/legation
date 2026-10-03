---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-svelte": patch
---

The public surface is the six concepts (ADR-0022 step 10b). `@thomasfosterau/legation-effect`'s root index shrinks from 43 namespaces to the resource-graph API — `Node`, `Edge`, `Collection`, `Query`, `Aggregate`, `Mutation` (with `Mutator` as a deprecated alias), `Client`, `ClientStore`, `Transport`, `Server`, `Backend`, `MemoryBackend`, `Authorization`, `Predicate`, and the error classes. Everything else — the engine, the mirror seam, plan vocabulary (`Subset`/`Related`), protocol codecs, reactivity plumbing, and server assembly parts — moves to the new `@thomasfosterau/legation-effect/internal` subpath for adapter authors, which the sibling `@thomasfosterau/legation-*` packages now compose from.
