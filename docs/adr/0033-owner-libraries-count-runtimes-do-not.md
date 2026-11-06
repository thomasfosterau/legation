# ADR-0033: Package boundaries count the owner's own libraries as dependencies, not runtime platforms

Date: 2026-11-06
Status: Accepted. Supersedes in part [ADR-0006](0006-dependency-based-package-boundaries.md) (its "runtime globals count as dependencies" rule).

## Context

ADR-0006 draws package boundaries by dependency footprint: code that needs
only `effect` lives in the core, and anything that brings a dependency gets a
package of its own. It also counted **runtime globals as dependencies**, so
Node-only code went in `@thomasfosterau/legation-node` and the SQL reference
backend, which needs only `effect` (its PostgreSQL executor reads
`effect/sql/SqlClient`, which ships in the `effect` peer), still went in a
package of its own, `@thomasfosterau/legation-sql`.

Before the first publish the owner reviewed the package set against the apps
that will consume it. Every one of them runs on Cloudflare Workers; none runs
a Node server, so `@thomasfosterau/legation-node` (`HttpSyncServer`, the RPC
sync transport on Node's HTTP server) has no consumer. And a separate SQL
package cost a version, a changelog and a cross-package type resolution for no
isolated dependency.

## Decision

- **A dependency is a package the code imports and the consumer must install,
  and the owner's own libraries count** (`@thomasfosterau/effect-jsonapi`,
  `@thomasfosterau/effect-svelte`): code that needs one lives in a package of
  its own, which takes it as a dependency.
- **A runtime platform is not a dependency.** Code is not split out of the
  core because it targets one runtime; it is split out only for what it
  imports. The core still runs in browsers, workers, edge runtimes and Node,
  and still imports no runtime (`node:*`, DOM beyond the `WebWorker` lib).
- **Provider and integration packages are merged or split case by case, by
  the owner.** That is a decision about consumers, not a mechanical test.
- Applied now:
  - `@thomasfosterau/legation-sql` merges into the core as the
    `@thomasfosterau/legation/sql` entry. It stays off the root and
    `./internal` barrels, so an app without a database never loads it.
  - `@thomasfosterau/legation-node` is dropped: no app runs a Node server. The
    RPC sync transport needs nothing Node-specific (`effect/rpc`'s
    `RpcServer` over the core's `RpcTransport.SyncRpcs`); an app that serves it
    from Node composes those with `@effect/platform-node` itself, as the
    commerce example does.
  - `@thomasfosterau/legation-cloudflare` stays a package of its own for now:
    it is built against the workerd types, which it declares as an optional
    peer (`@cloudflare/workers-types`). Alchemy's Cloudflare provider
    (`@alchemy.run/cloudflare`, 2.0.0-beta.85) re-exports none of those types,
    so peering on it would not supply them. The owner has decided to replace
    this package with an Alchemy-based alternative; that is a separate
    change.

## Consequences

- The "is this core?" test becomes: _does it import a package beyond
  `effect`?_ A runtime-specific module that imports nothing beyond `effect`
  can live in the core, on an entry of its own if apps on other runtimes
  should not load it.
- ADR-0019's tier-2 polling hint source ships in `@thomasfosterau/legation/sql`
  rather than a separate package, and ADR-0003's note that only
  `@thomasfosterau/legation-node` declares `engines.node` no longer applies:
  no package declares `engines`.
- `.fallowrc.json` loses the `node` and `sql` zones; the core's zone keeps no
  allowed imports.
