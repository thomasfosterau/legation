# ADR-0032: Shared anonymous CVRs: one conversation per public subscription, edge-cacheable pulls

Date: 2026-10-23
Status: Accepted (issue #208; designed now, built when an adopter needs it). Amends ADR-0009's per-client CVR bookkeeping and ADR-0022's per-user-room topology for the anonymous case. Shares its cookie definition with ADR-0015's #205 amendment.

## Context

The engine's unit of server state is the per-client CVR (ADR-0008,
ADR-0009). ADR-0022's reference topology puts each user in a Room. That
fits a signed-in app, where each client's windows are its own. It does not
fit the load PreferenceFlow exists to serve, an election-results site on
count night:

- The corpus is **entirely public**: read-only over the API and written
  only by batched ingestion. One feed message rewrites every contest,
  candidate and polling place of an election.
- The readers are **anonymous**, tens of thousands at once for a few
  hours, all looking at the same few windows.

Per client, the server stores an identical CVR and computes an identical
patch from an identical cookie, fanned out from one write that touched
thousands of rows. If every anonymous client at cookie _C_ gets a
byte-identical patch, the pull is **cacheable at the edge**, and the spike
collapses to one origin computation per (subscription, cookie generation).

The failure mode is serving one viewer's rows to another, so the
eligibility rule matters more than the saving. ADR-0015's #205 amendment
also folds a per-session scope epoch into the cookie, so the two decisions
share one cookie definition.

## Decision

### 1. Eligibility is a property of the declaration

A subscription is **shared** when both of these hold:

- its collection's auth filter, applied to the **anonymous identity**,
  resolves to a constant: `AllowAll`, or a predicate that names no named
  set and no identity value (ADR-0015 amendment, decisions 1 and 3); and
- the subscription's own predicate only narrows that constant. It is an
  ordinary client or named-query subset AND-ed with it, and it does not
  depend on the requesting client.

This is checked **when the policy is built**: `Authorization.policy`
evaluates each filter against the anonymous identity once and marks the
collection shareable or not. It is never checked per request. Every other
case (a filter that resolves sets, reads the client group or fails for
anonymous; any non-anonymous identity) keeps a per-client CVR. `Deny`
for anonymous is not shareable; it is unreachable.

### 2. A shared conversation is keyed by (subscription, cookie generation)

A shared subscription has **one** server-side conversation. Its CVR store
key is the authorized subset's canonical key (collection, the client
predicate AND-ed with the anonymous auth constant, order, limit, hashed
with `Hash.canonicalJson`) plus a **generation** cookie that the shared
conversation mints. A client holds its shared subscriptions' cookies
separately from its per-session cookie. A shared cookie has its own form,
`{namespace}::shared::{generation}`, and carries **no scope epoch**: the
anonymous identity has no sets that can move. A cookie is either
per-session (with an epoch) or shared-anonymous (without one), never both
(ADR-0015 amendment, decision 6).

A shared pull is `(subscription key, cookie) → (patch, next cookie)`, a
pure function of the shared conversation's state. It carries **no mutation
acknowledgements**. `lastMutationIds` and `rejected` are per client group
and cannot be in a shared response. An anonymous client group with a
non-empty journal therefore pulls its windows per-client, as today; the
count-night reader has no journal. Writes are untouched: mutation ids and
the journal stay per client (ADR-0008).

### 3. The pull is edge-cacheable, and staleness only delays convergence

A shared pull is a `GET` whose URL names the subscription key and the
cookie. It is answered with `Cache-Control: public` and a short `max-age`
(the declared staleness bound; seconds on count night), so a Workers cache
serves every client at that cookie after the first. A cached answer is a
valid patch from _C_ to some earlier generation _G′_. The client then holds
_G′_ and its next pull continues from there. Pull stays the correctness
path, and a stale cache entry delays convergence without corrupting it.

The client merges rows from several conversations into one replica, so it
records which conversations hold each row. A `Del` from one conversation
removes the row only when no other conversation (shared or per-session)
still holds it. A per-client CVR has never needed this, because one CVR
covered every subscription a client had.

### 4. Pokes route per topic, not per session

A shared conversation leases its topics once (ADR-0023), not once per
reader. A hint on those topics advances it and pokes the sessions attached
to it. Those sessions pull, and the pulls hit the cache. The per-group
poke hub collapses storms per client group. The shared case collapses them
per **topic**: one outstanding poke per shared conversation. In the
Cloudflare topology a shared conversation lives in its own Durable Object
(a shared room), not in any user's room; user DOs and anonymous sockets
attach to it.

### 5. A client that turns out to be authenticated leaves

When a pull resolves to a non-anonymous identity, the origin refuses the
shared pull for it. The client drops its shared cookies and subscribes per
session, starting a new per-client conversation with a scope epoch. A
shared CVR never follows a client across that transition. This is the
same boundary #212 draws for the durable replica (anonymous → signed-in is
the benign upgrade, a reset never a rebase), seen from the server. The edge
cannot resolve identity, so a cached shared answer can still reach an
authenticated client. That is safe: by decision 1 it holds only rows the
anonymous identity may read, which are public.

### 6. A shared CVR never holds a row the anonymous identity may not read

The anonymous auth constant is part of the shared subscription's key and
its evaluation, so the shared CVR is computed under the anonymous scope
only. No per-session filter, named set or epoch reaches it. If a policy
change makes a collection unshareable, the fleet namespace bump (#48) or a
policy-change rebuild invalidates every shared cookie. Every shared reader
then resets onto its per-client path.

## Consequences

- Count night costs one patch computation per (subscription, generation)
  plus cache hits, instead of one per client.
- `Authorization.policy` gains a shareability verdict per collection,
  computed at construction. A filter that consults the client group or
  resolves sets for anonymous is never shareable.
- The client tracks row membership per conversation for deletes. This is
  the one client-side change.
- **Not built yet.** The implementation (the eligibility check, a
  load-shaped test where N clients at one cookie cost one computation, and
  a test that a shared CVR never holds a row the anonymous identity may
  not read) is a follow-up issue, filed when an adopter needs the
  count-night load shape.

## Rejected

- **Per-client CVRs with edge-cached pulls.** The patch is keyed by a
  per-client cookie, so nothing is shared to cache.
- **Deferring the design.** The cookie definition is shared with #205's
  scope epoch and must be decided once, now.
- **Sharing among authenticated identities.** Identity-scoped filters make
  the CVR per-scope by construction. Out of scope (#208).

## Open points

1. **Generation minting.** Whether a generation advances on every hint or
   on a coalescing interval (bounded by `max-age`) is a tuning choice left
   to the implementation.
2. **Cache key privacy.** The subscription key appears in a URL. It names
   only public windows, but its encoding (hash or canonical string) is the
   implementation's choice.
