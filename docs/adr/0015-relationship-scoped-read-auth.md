# ADR-0015: Relationship-scoped read authorization via allow-set predicates

Date: 2026-06-18
Status: Accepted

## Context

Deny-by-default auth filters (ADR-0009) are a function `SyncContext → Predicate`, AND-ed into every subscription before evaluation. Ownership auth (`ownerId == ctx.identity`) is a flat predicate over the row's own fields and was already covered. The harder case Zero handles naturally is **relationship-scoped** visibility: "an issue is visible if you are a member of its project" — a rule that depends on another collection (memberships), not just the row.

Two facts shape the answer:

- An `AuthFilter` returns an `Effect<Predicate, AuthorizationError>`, so it may run arbitrary effects — query a membership service, read a tenant table — before producing its predicate. It is not restricted to pure field comparisons.
- The predicate language includes `In` (`field IN (…)`). So a filter can resolve the **set of keys the principal is allowed to see** and return `Predicate.isIn(key, allowed)`.

The missing piece was identity: `SyncServer` built `SyncContext` as `{ clientGroupId }` with no principal, so a filter had nothing to scope by.

## Decision

**Relationship-scoped read auth is expressed as an allow-set predicate**: the auth filter resolves the principal's permitted keys (the projects they belong to, the tenants they can see) and returns `isIn(key, allowed)` over a key carried on the row. The row denormalizes that key (e.g. an issue carries `projectId`); the filter supplies the membership.

To give the filter a principal, add an **identity seam**: an optional `IdentityResolver` service `(clientGroupId) → Effect<identity>` that `SyncServer` consults to populate `SyncContext.identity` on every push and pull. A carrier derives identity from its authenticated connection (a verified token) and provides the resolver; absent, identity stays `undefined` and deny-by-default holds. The resolved identity is never client-forgeable — it comes from the server side of the boundary, not the request body.

The collection-wide narrowing remains AND-ed with the client's own predicate, so a client can only ever narrow within what the filter allows.

## Consequences

- The common relationship-scoped cases work today with no new machinery: denormalize the scoping key onto the row, and write a filter that returns `isIn(key, allowedFor(identity))`. The membership lookup is an ordinary effect (cache it, batch it, back it with whatever store).
- The identity seam also completes the auth-token story: middleware and filters now see a real principal, resolved once per request.
- The cost is **denormalization of the scoping key**. Visibility that depends on a relationship the row does not carry (a transitive or many-hop rule) cannot be expressed as a flat allow-set without first materializing the key onto the row.
- **Deferred — join-evaluated filters.** A filter that references another collection's rows _without_ denormalization (a true server-side join in the auth path) would need a join-evaluation seam in the backend contract: the filter yields a relational expression the backend resolves against its own storage. That is a larger contract change and is left to a future ADR; the allow-set pattern covers the majority of cases until then.
