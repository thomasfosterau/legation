# packages/jsonapi — `@thomasfosterau/legation-jsonapi`

JSON:API loaders, derived sync and the replica-served façade. Read the root [AGENTS.md](../../AGENTS.md) first.

## Boundary

- The JSON:API wire types, schemas and query encoding come from `@thomasfosterau/effect-jsonapi` (ADR-0016), a runtime dependency; never re-implement them here. Imports from the workspace: `@thomasfosterau/legation-effect` only.
- In the engine's model a JSON:API `type` is a collection, a resource `id` a row id, a resource a row value (ADR-0008).

## Invariants

- **Read-side**: reads come from JSON:API documents; writes are the engine's named mutators, replayed as `POST` / `PATCH` / `DELETE` or one `atomic:operations` request (ADR-0030), never ad-hoc REST calls.
- **The filter bridge is exact** against the engine's filter grammar (ADR-0028); `FilterCorpus` cases pin it.
- **The façade answers only covered reads** from the replica (ADR-0029); an uncovered `GET` is forwarded, never answered from a partial replica.

## Tests

`src/__tests__/` (Vitest project `node`). The commerce example's tests (`examples/commerce/tests`) exercise the façade end to end, including in Chromium.
