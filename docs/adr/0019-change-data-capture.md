# ADR-0019: Change data capture for out-of-band writes

Date: 2026-07-02

Status: Accepted

## Context

Fan-out (ADR-0009) pokes a client group when a committed push produces change
hints: `SyncServer.handlePush` publishes the backend's hints to the
`InvalidationBus`, and the fan-out loop matches them against active
subscriptions. That path only fires for writes that go **through a mutator**.
Real systems also write out of band — a cron job, an admin tool, another
service, a `psql` session — and those writes never produce a hint, so a
subscribed client only sees them on its next interval pull. Correctness holds
(pull is the correctness path), but realtime delivery does not.

We need a way for out-of-band changes to poke subscribers, without owning a
replication pipeline (ADR-0009 deliberately declined to) and without dragging a
database-client dependency into the engine core (ADR-0006 keeps package
boundaries dependency-based).

The available mechanisms form a natural tiering, from least to most
infrastructure:

1. the writer publishes a hint itself;
2. the server polls storage for changes;
3. the database pushes a change signal (Postgres `LISTEN`/`NOTIFY`);
4. a logical-replication consumer decodes the WAL.

## Decision

Ship tiers 1–3; reject tier 4. Introduce a small formal `HintSource` seam in
core so every tier feeds the same `InvalidationBus` the same way.

- **`HintSource` seam (core, `@thomasfosterau/legation-effect`).** A `HintSource` is an effect
  (`run`) that publishes `ChangeHint`s to the in-context `InvalidationBus` until
  its scope closes; `HintSource.fromStream` lifts a stream of hint batches, and
  `HintSource.run` forks a source onto a scoped fibre alongside the SyncServer.
  A source that publishes **value-less** hints (no `values`) is matched at the
  collection level by the #42 fan-out matcher — sound, because over-matching a
  poke only costs an empty pull and poke is never a correctness dependency.

- **Tier 1 — app-hint (documented baseline).** Any writer calls
  `InvalidationBus.publish([{ collection, ids }])`. Over a shared broker
  (`BusBrokers`) the hint reaches every instance. This already works; it is now
  documented as the official baseline for out-of-band writes the app controls.

- **Tier 2 — polling (shipped in `@thomasfosterau/legation-sql`).**
  `PollingHintSource.make({ executor, tables, interval })` polls each table on
  an interval for a cheap change-detector — `COUNT(*)` plus `MAX(versionColumn)`
  when a version column is mapped — and publishes a value-less hint for a
  collection whose detector moved. It uses only the existing `SqlExecutor` seam,
  so it adds no dependency and lives in `@thomasfosterau/legation-sql` (ADR-0006), not core.
  Bounded staleness equals the poll interval; the cost is the extra read load.
  Coverage is honest: without a monotonic version column the detector sees only
  row-count changes, so an in-place update that keeps the count is missed —
  recommend a `versionColumn` (or `updated_at`) for full coverage.

- **Tier 3 — Postgres `LISTEN`/`NOTIFY` (documented recipe only).** A trigger
  function calls `pg_notify` with the changed collection and id; the app opens a
  `LISTEN` on its own pg client, decodes payloads into `ChangeHint`s, and feeds
  `HintSource.fromStream`. The trigger DDL and the client are the app's to own
  (bring your own pg client). We do **not** create a `@thomasfosterau/legation-pg` package or
  add a `pg` dependency now; if this recipe ever becomes shipped code, a
  `@thomasfosterau/legation-pg` package is its future home (ADR-0006), exactly as polling stays
  in `@thomasfosterau/legation-sql`.

- **Tier 4 — logical replication (rejected).** Decoding the WAL with a
  replication slot is precisely the operational pipeline ADR-0009 declined to
  own: it is heavy, coupled infrastructure (slot lifecycle, publication
  management, back-pressure, ordering) and the BYO contract exists to avoid it.
  Rejected. An app that wants it can still run its own consumer and feed
  `HintSource.fromStream` — the tier-3 shape generalises.

## Consequences

- Out-of-band writes can poke subscribers through one uniform seam, at the
  tier an app is willing to operate: publish a hint (tier 1), poll (tier 2), or
  wire `LISTEN`/`NOTIFY` (tier 3).
- Because every tier emits value-less hints (except tier 1, which may carry
  ids), the #42 fan-out matcher falls back to a collection-level match for them:
  every group subscribed to a changed collection is poked and reconciles on the
  next pull. Sound by construction — over-matching is safe.
- Dependency boundaries hold: polling ships in `@thomasfosterau/legation-sql` on the existing
  executor seam, and Postgres-specific code stays out of core as a recipe, its
  future home a `@thomasfosterau/legation-pg` package if it is ever built (ADR-0006).
- The engine still owns no replication pipeline (ADR-0009); tier 4 is declined,
  with an escape hatch (`HintSource.fromStream`) for apps that run their own.

## References

- ADR-0006 — dependency-based package boundaries (why polling stays in
  `@thomasfosterau/legation-sql` and pg would be its own package).
- ADR-0009 — BYO backend contract; no operational pipeline (the tier-4
  rejection basis and the poke-then-pull fan-out this feeds).
