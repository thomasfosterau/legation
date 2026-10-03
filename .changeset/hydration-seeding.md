---
"@thomasfosterau/legation-effect": minor
---

SSR hydration, engine seeding, and subset prefetch (#41). A client's durable
state can now cross a serialisation boundary, and the local view can be warmed
before the first network round-trip.

- `Hydration.dehydrate` reads a `ClientStore` into a plain `Snapshot` (confirmed
  rows flattened with their collection, the pull cookie, and the journal);
  `Hydration.hydrate` writes one back, validating it through `SnapshotSchema` on
  the way in so a `dehydrate → JSON → hydrate` round-trip is schema-checked and a
  malformed snapshot fails as a `StoreError`. `SnapshotFromJson` folds the JSON
  step into the decode. The module doc walks the SSR flow (server pulls once,
  `dehydrate`s; client `hydrate`s and continues from the same cookie — no
  refetch) and the seeded-versions caveat.
- `ClientEngine.seed` writes confirmed rows and reveals them with a single rebuild
  scoped to the seeded collections, so observers render synchronously before any
  transport call. Versions must be genuine backend versions for CVR diffing to
  converge on the next pull; self-invented versions are safe but degrade to the
  reset path.
- `ClientEngine.ensureSubset` prefetches a subset: it subscribes, and if the
  subset yields no local rows, pulls once. Concurrent calls for the same subset
  dedupe on `Subset.hash`, so a burst of prefetches triggers at most one pull.
- `ClientStore` gains `listCollections` (the enumeration `dehydrate` walks),
  implemented for both the in-memory and KeyValueStore-backed stores.
