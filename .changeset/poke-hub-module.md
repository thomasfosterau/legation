---
"@thomasfosterau/legation": minor
---

**Breaking:** `Transport.makePokeHub` is no longer exported. The poke hub was always the sync server's internal piece, and it now lives in a private `PokeHub` module that is on no entry. Nothing replaces it on the public surface: a carrier reads a client group's pokes through `ServerHandler.pokes`, as before.

`Transport.layerInMemory` takes an optional second argument, `makeInMemory`'s `InMemoryOptions`, so the credentials each call presents can be set on the layer too. `Hydration.snapshot` now builds its request-scoped store and its in-process transport from fresh layers (`Layer.fresh`). Its requirements are unchanged, and no two renders share a store or a carrier.

Some declarations now live in private modules and are re-exported or imported back under their old names, so their names, entries and types are unchanged: `Predicate.holds`, `Predicate.fieldValue`, `Incremental.deltaFromChanges`, `Node.make`'s default for `Edges` (still `{}`), and the `hydrated` and `pulled` wire fields.
