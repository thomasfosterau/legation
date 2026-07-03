# ADR-0023: Topic-derived fan-out

Date: 2026-07-03
Status: Accepted (companion to ADR-0022)

## Context

ADR-0022's reference server topology (Cloudflare Workers: per-user Durable
Object rooms, per-resource/edge Durable Objects for fan-out, Postgres as
the authoritative source of truth) leaves one mechanism undesigned: **how a
committed mutation finds the rooms to poke**. Subscriptions are predicate
windows, so the naive answers both fail — poke everyone (correct but
O(rooms) per write) or per-node routing (misses **inserts**, which match
windows that have never seen the node). True predicate-level matching is
incremental view maintenance — a different library (see
`docs/comparisons/zero.md`) — and unnecessary here, because a poke is a
hint: pull is the correctness path (ADR-0008), over-delivery collapses in
the sliding poke hub, and dropped hints only delay the next pull
(ADR-0019). Fan-out precision is a **cost knob, not a correctness knob**.

## Decision

Fan-out is publish/subscribe over **derived topics**. The fan-out layer
never evaluates a predicate.

### Topics

For a node type `C`, the topic space is:

- the coarse topic `C`, and
- fine topics `C/field=value`, allowed **only** for fields in the node's
  **derivable set**: the foreign fields of its edges (from the ADR-0022
  Node/Edge graph), plus any hint keys the node declares explicitly
  (`hintKeys: ["userId"]` — typically the auth-scoping key, which is
  usually an edge anyway).

Fine topics name graph locations: `reviews/productId=p-1` _is_ the
`(products/p-1).reviews` edge; `cartItems/userId=u-9` _is_ that user's
cart. The derivable set is declared on the Node, so both sides of the
system agree on which fine topics exist.

### Registration (rooms → shards)

When a room's subscription set changes, it registers each query window
under the finest topic the window's predicate **legally** allows:

- an equality constraint on a derivable field → that fine topic
  (`where: { productId: "p-1" }` → `reviews/productId=p-1`);
- anything else — range predicates, non-derivable fields, whole-collection
  windows — → the coarse topic `C`.

Registrations are **leases**: rooms renew on a heartbeat and shards drop
expired entries, so crashed rooms age out without distributed cleanup
(the ADR-0011 liveness pattern, applied shard-side).

### Derivation (writes → topics)

Backend mutation handlers already pass every written row through the
write-through, so the implicit broadcast derives topics from the row's
**old and new** values — `C`, plus `C/f=v` for each derivable field `f` —
with zero developer effort. Old _and_ new values matter: an update that
moves a row between parents pokes both edge windows; a delete derives from
the old row. Out-of-band writers (`server.broadcast({ collection, ids? })`)
get coarse fan-out unless they supply values; CDC hint sources likewise.

### Delivery

Publish the topic set to its shards; each shard pokes its leased rooms;
rooms poke their (hibernated) sockets with a contentless poke; clients
pull through the room, which evaluates plans against the backend and diffs
CVRs — unchanged machinery. The shard is the existing broker seam plus a
topic key:

| Deployment          | Shard                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Single Node process | entries in an in-process `Map` (plain objects)                                             |
| Cloudflare Workers  | one Durable Object per topic (or hashed topic bucket)                                      |
| Multi-instance Node | topic-keyed channels on the serialized broker (Redis Streams / WebSocket broker, ADR-0011) |

### Soundness

- **Under-poking is impossible by construction**: a room can only register
  a fine topic drawn from the derivable set, and every write emits every
  derivable-set topic for its old and new values. The declaration lives on
  the Node, so registration and derivation cannot disagree.
- **Over-poking is harmless by design**: coarse-topic windows are poked for
  every write to the collection; the per-group sliding poke hub collapses
  storms; an unnecessary pull is a cheap no-op diff.
- Pull-interval polling remains the safety net beneath all of it — a lost
  hint (bus drop, shard restart mid-lease) delays convergence, never
  prevents it.

## Consequences

- Fan-out cost scales with topic cardinality, not subscriber count per
  write: hot edges concentrate on their own shards; cold topics cost
  nothing until registered.
- The Node/Edge graph earns its keep server-side: edge declarations are
  simultaneously the join spec (client), the sync-window spec (protocol),
  and the fan-out routing spec (server).
- Precision is tunable per node (`hintKeys`) without touching the engine;
  anything finer than equality topics is explicitly out of scope (that is
  IVM territory).
- The `FanoutBroker` seam (topic pub/sub + leases) replaces the current
  flat `InvalidationBus` channel inside `Server`; in-process, Redis, and
  Durable Object implementations satisfy the same contract, and the
  `@legation/cloudflare` adapter ships the DO shard class alongside the
  user-room class.
