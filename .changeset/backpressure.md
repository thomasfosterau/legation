---
"@legation/effect": minor
"@legation/browser": minor
---

Bound every in-process message hub so a stalled or slow consumer can no longer
grow a queue without limit (#44). Because pull is the correctness path, each hub
sheds load under pressure without threatening convergence:

- **Poke hub** (`Transport.makePokeHub`): now `sliding(1)` per client group with
  replay 1. A poke storm collapses to one queued poke per group — an outstanding
  poke absorbs the rest — and a late/reconnecting subscriber still sees the most
  recent poke.
- **Invalidation bus** (`InvalidationBus.makeInProcess` and the memory broker):
  now bounded with a `dropping` strategy at a configurable capacity. A dropped
  hint only delays the next pull (ADR-0009); drops are counted in
  `legation_hints_dropped_total`. New `makeInProcessWith` / `layerInProcessWith`
  / `makeMemoryBrokerWith` take a `capacity` option.
- **Engine change hub** (`ClientEngine`): now bounded `dropping` at a
  configurable capacity (`ClientEngineOptions.changeHubCapacity`, default 1024).
  Each view-change carries a monotonic sequence number; a consumer that sees a
  seq gap collapses it into a full `Rebuild` that subsumes the dropped `Patch`es,
  so the view stays correct under pressure and behaves identically under none.
  Collapses are counted in `legation_change_collapses_total`.
- **Mirror change hub** (`TabMirror`): now bounded `dropping` at a configurable
  capacity (`TabMirrorOptions.changeHubCapacity`, default 1024). A seq gap makes
  the observer re-read its subset from the mirror's `Ref` (a full refresh,
  lossless because the `Ref` holds the latest rows), counted in
  `legation_mirror_refreshes_total`.

A `Patch` is never silently dropped: it is only ever shed behind a seq gap that
forces a `Rebuild` before the view is next read.
