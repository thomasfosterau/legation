---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-sql": minor
---

Change data capture for out-of-band writes (ADR-0019). Writes that bypass the
mutators — a cron job, an admin tool, another service, `psql` — can now poke
subscribed clients through a new `HintSource` seam.

`@thomasfosterau/legation-effect` gains `HintSource`: a small, dependency-free seam that
publishes `ChangeHint`s to the `InvalidationBus` on a scoped fibre alongside the
SyncServer. `HintSource.fromStream` lifts a stream of hint batches and
`HintSource.run` forks a source for the caller's scope. A source that publishes
value-less hints is matched at the collection level by the existing fan-out
matcher — sound, because over-matching a poke only costs an empty pull.

`@thomasfosterau/legation-sql` gains `PollingHintSource`: a tier-2 polling source over the
existing `SqlExecutor` seam (no new dependency). It polls each table on an
interval for a cheap change-detector — `COUNT(*)` plus `MAX(versionColumn)` when
a version column is mapped — and pokes a collection whose detector moved.
Bounded staleness equals the interval; without a monotonic version column it
detects only row-count changes, so map a `versionColumn` (or `updated_at`) for
full coverage.

Tiers shipped: tier 1 (app publishes `InvalidationBus.publish`) documented as
the baseline, tier 2 (polling) shipped here. Tier 3 (Postgres `LISTEN`/`NOTIFY`)
ships as a documented recipe — bring your own pg client — and tier 4 (logical
replication) is rejected (ADR-0019, citing ADR-0009). See
`docs/change-data-capture.md`.
