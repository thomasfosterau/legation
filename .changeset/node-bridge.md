---
"@legation/jsonapi": minor
---

The effect-jsonapi Node bridge (ADR-0022 program step 9): `NodeBridge.fromResource` / `NodeBridge.registry` derive the sync engine's node graph from `@thomasfosterau/effect-jsonapi` resource definitions — one/optional relationships become one-edges with derived key fields, many/paginated relationships resolve their inverses across bridged one-edges, and the `edges` option promotes a foreign-key attribute to an edge so the library's acyclic resource graphs bridge without hand-naming inverses. Bumps the effect-jsonapi dependency to ^0.6.0.
