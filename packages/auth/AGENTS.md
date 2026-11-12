# packages/auth — `@thomasfosterau/legation-auth`

The effect-auth bridge to legation's auth seams (#219): identity resolution, read scopes and the sign-out reset. Read the root [AGENTS.md](../../AGENTS.md) first. **Private** (`"private": true`): it is not published until the owner sets up its npm trusted publisher; `scripts/pack.mjs` (so `pack:check` and the release) skips private packages, and it carries no changeset.

## Boundary

- Imports from the workspace: `@thomasfosterau/legation` only (its `./internal` entry for types). Core gains nothing from this package and never imports effect-auth.
- **Peers:** `@thomasfosterau/effect-auth ^0.2.0` (the app configures its services, so there is one copy) and `effect ^4.1.0` (`catalogs.auth-peers`), because effect-auth 0.2.x peers `effect ^4.1.0`. This package's `effect` floor is 4.1.0; its tests are their own Vitest project (`auth`) so CI's "Tests (effect floor, auth)" runs them at it. effect-auth's `@thomasfosterau/effect-jsonapi` peer is optional and unused here.
- **Two entries.** `.` (`src/index.ts`, server side): `Principal`, `Resolver`, `ReadScopes`. `./client` (`src/client.ts`): `SignOut`. The client entry imports **no effect-auth runtime** (effect-auth's root barrel reaches `node:crypto`), only legation and `effect/crypto`'s `Digest`; keep it that way.
- Written against effect-auth's core services (`SessionService`, `ApiKeyService`, `SessionResolution`, `ReadScope`), never its HTTP tier: it runs against an in-process effect-auth. Never guess effect-auth's API: read `node_modules/@thomasfosterau/effect-auth/dist/*.d.ts`.

## Invariants

- **Fail closed.** `Resolver` re-validates the request's credential on every resolve, and every failure — absent, unknown, expired, revoked or disabled credential, a store fault, a defect, a throwing header lookup — resolves to `Principal.anonymous`. It never fails the request and never returns a partially trusted principal. An interrupt is passed through, not converted. A request carrying an API key header is decided by the API-key plane alone.
- **Narrow, never widen.** `ReadScopes` translates effect-auth's scope exactly or not at all: an `Inexact` compilation, an untranslatable node (a `Compare` on text or booleans), an unmapped attribute, a literal of the wrong kind or out of its domain, and a failing or dying compile all become a typed `ScopeMappingError`, and the auth filter answers `Deny`. It never drops a conjunct and never falls back to `AllowAll`; only effect-auth's own `AllowAll` becomes legation's. Attribute coverage and set declarations are checked when the mapping is built (`ReadScopes.mapping` / `policy`), not per request.
- **Two-valued in, three-valued out.** effect-auth's predicate is two-valued (absent ⇒ `Eq` / `Compare` / `InSet` false); legation's is Postgres's three-valued logic (ADR-0028). Every such atom is translated as `field IS NOT NULL AND atom`, so the translated scope admits exactly the rows effect-auth's `ReadScope.matches` admits; `corpus-oracle.test.ts` checks that row by row. Instants are `DateTime.formatIso` (= `Date#toISOString`) of whole milliseconds in years 0000–9999.
- **Credentials are never logged or carried.** A principal holds no token, key or hash (effect-auth reports a validated session's `id` as the raw token, so it is dropped). Log lines name only the plane and failure kind (resolver) or the collection and reason (scopes); `ScopeMappingError` messages name collections, attributes and policy ids.
- **Sign-out quarantines.** `SignOut.onSessionChange` adopts the next session's fingerprint with `Client.reset` (#212): a superseded user's unpushed journal is quarantined, neither flushed nor discarded. The decision compares with the replica's stamp, not `previous`. Fingerprints are `legation-auth:sha256:<hex>` of the user id under a domain separator, never the id.

## Tests

`src/__tests__/` (Vitest project `auth`). `harness.ts` runs effect-auth in process: `SessionService` and `ApiKeyService` over effect-auth's testing memory stores and a memory `ApiKeyStore`, with stores that fail (`AuthError`) or die on demand.
