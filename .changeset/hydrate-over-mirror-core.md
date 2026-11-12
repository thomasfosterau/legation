---
"@thomasfosterau/legation": minor
---

A server-rendered snapshot can be hydrated into a store the tab does not own (#146, ADR-0021 amendment §6): the `hydrate` host-request kind.

- **`Hydration.requests.hydrate`** (single-reply): the request is a `Hydration.Snapshot`, the response a `Hydration.HydrateOutcome`, `{ hydrated: boolean, reason?: "NotEmpty" | "AlreadyPulling" }` (`Hydration.HydrateDeclined`). A tab asks `mirror.request(Hydration.requests.hydrate, snapshot)`.
- **`Hydration.hydrateUnpulled(engine, store, snapshot)`**, the empty-store gate: with the engine's pulls held it hydrates iff the store is empty (`Hydration.isEmpty`) and no pull has started since the engine was built; otherwise it answers `hydrated: false` with the reason and leaves the store untouched. The first of concurrent snapshots wins.
- **`Hydration.makeGate(engine, store, { hold })`** and **`Hydration.handler(gate)`**: the gate a host serves the kind through. With `hold`, a gate made over an empty, unpulled store holds the engine's pulls until the first snapshot arrives or `hold` elapses.
- **`EngineHost.run`** serves `hydrate` whenever it is given its `store` (as it serves the introspection kinds), and takes **`hydrationWindow`**, the `hold` for a cold host, so a first visit's snapshot is not beaten by the sync loop's connect pull. A store that is not empty is never held.
- **`ClientEngine.withPullsHeld(body)`** runs `body` under the engine's pull lock, given the pull counters: a required member, so a hand-written `ClientEngine` must add it (one that spreads an engine, `{ ...engine }`, already has it).
