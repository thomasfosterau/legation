# ADR-0024: Paginated-edge sync windows

Date: 2026-07-03
Status: Proposed (design note for ADR-0022 program step 5)

## Context

ADR-0022 makes paginated edges first-class sync units: a
`(parent node, edge, cursor window)` triple has its own CVR window, its own
patches, and its own protocol representation, exactly like a root window.
It flagged this as the largest piece of new engine work in the program,
with its own correctness questions ("per-edge CVR windows"), and deferred
the design to this note.

Taking stock of what already exists changes the shape of the work. A
`Subset` already carries `(collection, where, orderBy, limit, cursor)`;
`Subset.apply` — filter, sort, cursor, limit — is the reference evaluation
semantics that `MemoryBackend.evaluate` implements and other backends must
match; the sync server's pull evaluates **each registered subset** into the
CVR next-view and diffs the union. So a windowed subset **already is** a
first-class sync unit with its own CVR entries, patches, and wire form. The
per-edge CVR question ADR-0022 flagged is answered by the existing union
semantics: a row leaving one parent's window but remaining in another's
stays in the union (no delete); a row leaving every window is deleted; a
row entering any window is put. Overlap is set union, which is exactly the
normalized-replica semantics ADR-0022 asks for ("windows hold memberships,
never copies").

What does **not** exist is the client side. A read like
`include: { reviews: { first: 2 } }` today registers one _unwindowed_
`foreignField IN (parent ids)` subset per target collection (the `Related`
reconcile loop), syncs the **entire dependent collection** for every
visible parent, and applies the edge window client-side at resolution
(`Query.applyWindows`, the step-3 staging note). Correct, but the replica
holds unboundedly more than the UI shows — for a product page with ten
products it syncs every review of each, to show two.

## Decision

A paginated edge's window compiles to **one windowed subset per parent
row**, registered and reconciled by the same machinery that today manages
the `IN` subsets:

```
include: { reviews: { first: 2 } }   over parents p-1, p-2
  ⇒  { collection: "reviews", where: productId = "p-1",
       orderBy: [createdAt desc], limit: 2 }
  ⇒  { collection: "reviews", where: productId = "p-2",
       orderBy: [createdAt desc], limit: 2 }
```

The subset's `orderBy` is the **edge's declared order** (part of the
edge's identity — ADR-0022), its `limit` is the read's per-edge `first`,
and its `where` is the equality over the one foreign key that already
powers the join, the auth scope, and the fan-out topic. No new protocol
object, no new CVR concept: the triple's "own protocol representation" is
a `Subset`, which subscriptions already carry.

### How the window select travels

The relational read's edge selection grows from names to **selects**
(`{ name, first? }`, plain strings still accepted):

- `Query.plan` already compiles `include` into `EdgePlan`s carrying
  `kind`/`first`/`order`; plan execution now passes windowed selects for
  paginated edges instead of bare names.
- `Collection.Relationship` gains the `"paginated"` kind with the edge's
  declared order, so the engine registry (and the host side of a mirror)
  can build windowed subsets without consulting Node definitions.
  `Node.registry` derives it from `Edge.paginated` instead of degrading to
  `"many"`.
- The `Related` strategy's per-collection `Target` gains an optional
  window; `desiredSubsets` emits one equality subset per parent id for
  windowed targets and keeps the single `IN` subset otherwise. The
  reconcile loop (diff subscribed vs desired on base-page changes) is
  unchanged — parents entering or leaving the root window register and
  release their edge windows exactly as `IN` members came and went.
- The mirror protocol's `SubscribeRelated`/`UnsubscribeRelated` carry the
  selects, and the registration key includes each edge's window, so reads
  differing only in `first` are distinct registrations. Host-side
  execution is otherwise unchanged (the host runs the same `Related`
  loop).

### Client-side windowing stays

`Query.applyWindows` still applies the edge window at resolution. With
windowed sync it is no longer a stand-in but the local half of the
semantics: the replica is normalized and may legitimately hold child rows
beyond one parent's window (overlapping windows, other root reads, local
optimistic writes not yet within any server window). Display membership is
re-derived from the same `(order, first)` the subset declares — the
client-side analogue of `Subset.apply`, applied to the join.

### Windows only where order is stable

Only paginated edges register windowed subsets: their declared order makes
the window well-defined on both sides. A `first` on a plain `many` edge
(no declared order) remains a client-side display window over the fully
synced dependent collection — a windowed subset without a stable order
would sync an arbitrary slice.

### Load-more is a wider window

Cursor semantics follow the existing `Subset` doctrine: "load more"
**widens** a registered window (re-register with a larger `limit`, or a
`cursor` at the last row) rather than fetching detached pages. A deeper
per-parent page is equally expressible as a root read on the child
collection (`{ collection: "reviews", where: { productId }, order, first,
after }`) — the same subset by another route. A per-parent `after` inside
`include` is deliberately **not** added yet: connection-style paging UI
arrives with the bindings step (program step 8), and the protocol needs no
change to support it when it does.

## Consequences

- The replica holds what the UI shows: `first: 2` syncs two reviews per
  product, not the dependent collection. The gap between "edges are
  dependent collections" and what actually synced is closed.
- Subscription payloads grow linearly with the root page size (one subset
  per parent per paginated edge). Accepted: subsets are small, pulls
  already carry the subscription list, and the count is bounded by the
  root window's own `first`. If it ever matters, a batched wire form
  (`where: FK IN (...) windowed per key`) is a pure protocol compression
  with the same semantics — CVR and evaluation are unchanged by it.
- Backends must honour `Subset` windows in `evaluate` (filter → sort →
  cursor → limit). This was already the documented contract
  (`Backend.evaluate`: "in subset order, respecting limit/cursor") and the
  memory backend's behaviour; SQL backends translate to
  `WHERE … ORDER BY … LIMIT …`.
- A new newest child arriving pokes the window's topic (the equality over
  the FK is exactly ADR-0023's fine topic); the next pull re-evaluates the
  window, puts the entrant, and deletes the displaced row **iff** no other
  registered window still holds it — CVR union semantics, no new
  mechanism.
- Two relationships from one collection targeting the same foreign
  collection keep today's behaviour (the strategy pins one target per
  collection); combining a windowed and an unwindowed edge to the same
  target falls back to the unwindowed superset. Sound, over-syncs, noted
  as a limitation.
