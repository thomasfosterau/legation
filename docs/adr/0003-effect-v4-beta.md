# ADR-0003: Target Effect v4 beta

Date: 2026-06-03
Status: Accepted

## Context

The repository adopted `effect@4.0.0-beta.65` (pinned exactly) before the monorepo restructure. Effect v4 reworks significant APIs relative to v3 (Context.Service, Result vs Either, fork variants, unstable/http modules, Cause reasons) and is the framework's future, but it is a beta: APIs can break between beta releases.

## Decision

Keep targeting Effect v4 beta across all packages, with the version pinned exactly (`4.0.0-beta.65`, no caret) as both peer and dev dependency. Re-evaluate and bump deliberately, package-wide, in a single PR each time.

## Consequences

- We get v4's better ergonomics (yieldable services/errors, ManagedRuntime, unstable/persistence KeyValueStore) and avoid a future v3→v4 migration.
- Production users must accept beta-channel risk; this is documented in each package README ("Targets Effect v4 beta").
- The pinned version means dependabot/renovate won't silently move us; beta bumps are explicit decisions.
- Anything imported from `effect/unstable/*` (HTTP client, KeyValueStore) is double-beta and isolated to adapter/edge modules where practical.

## Update (2026-06-18)

The exact-pin-and-bump-deliberately policy stands; the specific version has moved with it. The pin now lives in the Bun workspace `catalog` (root `package.json`) — currently `4.0.0-beta.83` — which is the single source of truth all packages reference via `catalog:`. The `beta.65` figures above are the original decision's starting point, not the current pin.

## Update (2026-06-19)

Bumped the catalog from `4.0.0-beta.83` to `4.0.0-beta.84`, package-wide in one change per the policy above. The bump was forced by adopting `@thomasfosterau/effect-jsonapi` (ADR-0016), whose peer dependency is `effect >= 4.0.0-beta.84`. All quality gates (build, typecheck, test, lint, format) pass on the new pin.
