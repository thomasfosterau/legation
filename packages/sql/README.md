# @thomasfosterau/legation-sql

A driver-agnostic SQL reference backend for the
[`@thomasfosterau/legation-effect`](../effect) engine.

- **`Sql`** — a pure translator from a `Subset` predicate to a parameterized
  `WHERE` clause (and a full `SELECT`), with SQLite (`?`) and PostgreSQL (`$n`)
  dialects.
- **`SqlBackend`** — an implementation of the core `Backend` contract over a
  tiny `SqlExecutor` seam (`query` / `run` / `transaction`, and the optional
  `transactional` flag, which an executor without transactions sets to
  `false`). Bring your own
  driver (`bun:sqlite`, `effect/sql`, `pg`, …); the backend supplies
  subset evaluation, row fetching, and the transactional, idempotent,
  gap-checked mutation-id ledger.
- **`PollingHintSource`** — a tier-2 change-data-capture hint source over the
  same `SqlExecutor` seam: it polls each table on an interval for a cheap
  change-detector (`COUNT(*)` plus `MAX(versionColumn)`) and pokes subscribers
  when a collection changes out of band (cron, admin tools, `psql`). See the
  [change-data-capture guide](../../docs/change-data-capture.md).

Reads push the predicate to the database via `WHERE` and finalise
order/limit/cursor locally with `Subset.apply`. The `WHERE` is exact on both
dialects (ADR-0028): every node compiles to the three-valued expression
`Predicate.evaluate` computes. A table mapping's `kinds` declare which columns
are text, instants, numbers or booleans: a column declared `text` gets an
explicit code-point collation (`COLLATE "C"` / `COLLATE BINARY`) on every
comparison, literals bind by the declared kind, and booleans are stored as
`0`/`1` on SQLite and decoded back by the backend. Writes run app-authored
handlers inside one transaction, and each mutation's `lastMutationId` is
claimed before its handler runs. An executor without transactions sets
`transactional: false` and bumps after the handler instead (D1).

## Install

```sh
npm install @thomasfosterau/legation-sql @thomasfosterau/legation-effect effect
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.0` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR); install one copy of `effect` in your app (ADR-0003).

## License

MIT
