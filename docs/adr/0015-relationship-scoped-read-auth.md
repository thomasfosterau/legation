# ADR-0015: Relationship-scoped read authorization via allow-set predicates

Date: 2026-06-18
Status: Accepted — amended 2026-10-23 (#205: session-resolved filters, named sets, the scope epoch; see the amendment)

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
- **Join-evaluated filters (now supported).** A filter that references another collection's rows _without_ denormalization is expressed with the relational `Predicate.exists` node: a correlated test (`exists(collection where … and foreignField = thisRow.localField)`). A backend resolves it against its own storage with `Predicate.resolveExists`, rewriting it to an `In` allow-set before evaluation — MemoryBackend resolves it over its rows, the SQL backend via a `SELECT DISTINCT` subquery. So `issuesAuth = exists(memberships where userId = ctx.identity, correlate projectId)` works with no membership key on the issue. (The JSON:API backend can't resolve correlated joins over REST and fails closed on `Exists`; denormalize or use a join-capable backend there.)

## Amendment (2026-10-23, #205): session-resolved filters, named sets and the scope epoch

Decided 2026-10-23, together with ADR-0032 (#208), so that the CVR
cookie's meaning is settled once.

### Context

A real multi-tenant read scope is not a predicate over the row's own
columns. Gardeneria's, for every owned leaf:

```text
moderator+          → all rows
anonymous           → visibility = 'public'
signed-in member    → visibility = 'public'
                      OR ownerId = viewer
                      OR (visibility = 'followers' AND ownerId IN <the viewer's followingIds>)
```

The allow-set pattern above carries this only at a cost: `followingIds`
inlined as literals rebuilds the predicate on every pull, so the
subscription's identity churns; "moderator+ sees everything" becomes a
disjunct instead of a branch; and **nothing pokes when the set moves**.
Following someone changes `followingIds`, and every window over every owned
collection may gain rows while no row in those collections changed.

### Decision

**1. An auth filter returns one of three outcomes**: `AllowAll`, `Deny` or
a predicate. It is still resolved per session against `IdentityResolver`'s
output. `AllowAll` is the role short-circuit, a branch the filter takes for
an identity and not a disjunct. `Deny` matches nothing. The shape is a
contract with effect-auth, whose compiled read scope is the same
`AllowAll | Deny | { predicate, sets }` (effect-auth#203). If the two
diverge, one of them is wrong.

**2. Deny-by-default holds under `AllowAll`.** An undeclared collection is
`Deny`, as before. `AllowAll` is reachable only from a filter that the
policy declares for that collection and that returns it for the request's
identity. An undeclared collection and one declared as allow-all are
different states, and no default, fallback or failure turns the first into
the second. A filter that fails (`AuthorizationError`) fails the request,
as today. Today's `Authorization.allowAll` becomes a filter that returns
`AllowAll`.

**3. Named sets.** A filter declares the session-resolved sets it uses by
name (`followingIds`), each with a resolver over the session's identity,
and its predicate refers to the set **by name**
(`ownerId IN set(followingIds)`). The name, not the contents, is part of
the predicate's identity, so a subscription is stable across a pull in
which the set changed. Evaluation binds the name to the resolved values: a
literal `In` list for `MemoryBackend`, or a bound parameter list or
subquery in SQL. A set is resolved once per **scope epoch** (decision 4),
not once per row and not once per pull. effect-auth's set declarations map
onto these bindings unchanged (#219). `Exists` is not used on this path;
it stays server-authored only.

**4. The scope epoch is folded into the CVR cookie.** Every per-session
conversation has a **scope epoch**: an opaque counter the server keeps per
(client group, identity) beside its CVRs, and stamps into every cookie it
mints for that session. When a session's resolved set changes, its epoch
moves. The next pull then presents a cookie from an older epoch, which the
server treats as unknown, so the pull takes the **reset path** (`Clear` +
full puts, the same path an unrecognised cookie or a bumped fleet
namespace takes, #48). Only that session resets. The bus learns nothing
about following edges.

What moves the epoch: each named set declares its **source**, the
collection it is computed from (`follows`, narrowed to the viewer). The
session leases that source's topic as it leases a window (ADR-0023), so a
committed write to the source pokes the session's room, which advances the
epoch and pokes the session. Hints are droppable, so the safety net is a
declared maximum age per set: a set older than that is re-resolved on the
next pull, and the epoch moves only if the values differ. Two alternatives
were not taken: re-resolving every set on every pull and resetting on a
hash change, and app-supplied invalidation hooks.

A cookie names a CVR computed under exactly one scope. That is why a scope
change resets rather than diffs: no patch is ever computed between two
scopes, and a narrowed scope cannot leave a row behind on the client, even
when the old CVR was evicted or a cached resolution was stale.

**5. An unresolvable set narrows; it never widens.** A resolver that fails,
times out or has no identity to resolve against binds its set to the empty
set. `IN ∅` matches nothing, so the predicate denies through that branch
and the other disjuncts still apply. A filter that cannot decide an
identity's role returns `Deny`. No resolution failure ever produces
`AllowAll`. This matches effect-auth#190's posture (`isFollowerNever`).

**6. Cookies are either per-session or shared-anonymous.** A per-session
cookie carries a scope epoch. A shared-anonymous cookie (ADR-0032) carries
none, because the anonymous identity resolves no sets that can move, which
is ADR-0032's eligibility rule. No cookie is both.

### Consequences

- Gardeneria's scope is one declaration per collection: `AllowAll` for
  `moderator+`, a constant predicate for anonymous, and the member
  predicate over `set(followingIds)`.
- A set change costs one reset for one session. That is bounded and
  correct, but a reset is a full re-send of that session's windows, so a
  set that changes often belongs in rows (denormalised), not in a named
  set.
- `AuthFilter`'s signature widens, so it is a breaking change to
  `@thomasfosterau/legation-effect`'s auth seam. The implementation carries
  the changeset.
- Implementation (#205): the three-way return, named sets, the epoch, and
  tests that a session gains rows after its set changes with no row in the
  collection changing, that an unresolvable set yields no rows, and that an
  undeclared collection stays unreachable.
