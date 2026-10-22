# packages/effect — `@thomasfosterau/legation-effect`

The engine core. Read the root [AGENTS.md](../../AGENTS.md) first; this file carries only what is specific to this package.

## Boundary

- **Peer: `effect` only.** Nothing here imports a runtime (`node:*`, DOM globals beyond the `WebWorker` lib), a protocol library or a framework (ADR-0006). Code that needs one goes in its own package; `.fallowrc.json` gives this zone no allowed imports.
- **Two entries** (ADR-0022): `src/index.ts` (`.`) is the app surface — `Node`, `Edge`, `Collection`, `Query`, `Mutator`, `Client`, `Server`, `Backend`, `Authorization`, the errors. `src/internal.ts` (`./internal`) is the engine seams for adapter authors — `ClientEngine`, `ClientStore`, `Subset`, `SyncServer`, `Cvr`, `InvalidationBus`, `HintSource`, `Undo`, `Mirror*`, `Transport`, …. A new export goes on exactly one of them; moving one between them is a breaking change.
- The two entries share one bundle chunk (`vp pack`), so a value reached through both is the same instance.

## Invariants

- **Writes are named, schema-validated intents** replayed on server state (rebase, ADR-0008); never merge row values.
- **The wire and storage formats are protocol.** `Protocol.ts`, `MirrorProtocol.ts`, the `ClientStore` key layout and journal records are read by other versions of the engine (other tabs, a persisted store); a field rename or shape change needs a migration and a changeset that says so.
- **`Predicate` here is the filter grammar** (ADR-0028), not `effect/Predicate`; import effect's as `P` where both are needed.
- **The `BackendContract` suite** (`BackendContract.ts`) is the normative backend behaviour: every `Backend` (memory, SQL, JSON:API) runs it in its tests.

## Tests

`src/__tests__/*.test.ts` (Vitest project `node`); benchmarks are `*.bench.ts` (`vp run bench`, not a gate). `vp test run packages/effect` needs no build.
