# ADR-0011: Multi-instance deployment — serialized bus, shared CVR storage, tab-liveness heartbeat

Date: 2026-06-13
Status: Accepted — realises the distributed seams ADR-0009 and ADR-0010 left open

## Context

ADR-0009 made the invalidation bus and CVR storage pluggable seams "for distributed deployments" without choosing concrete cross-instance machinery, and ADR-0010 noted that BroadcastChannel gives a host no way to detect a tab that crashes without an orderly `Disconnect`. Three gaps remained before the engine could run as more than a single in-process instance:

1. **Cross-instance pokes** — a write committed on instance A must fan out to sessions held on instance B.
2. **Cross-instance pull continuity** — a client holding a cookie minted by A must be able to pull a minimal patch from B, not a full reset, on every request.
3. **Tab liveness** — a service-worker host must reclaim a crashed tab's subscriptions without relying on a goodbye message.

## Decision

- **Bus**: `InvalidationBus.makeSerialized` runs the whole bus over a `BusBroker` — a single string pub/sub channel, the entire distributed surface. Concrete brokers ship in core (they add no dependency footprint, ADR-0006): `makeRedisBroker` over Redis **Streams** (`XADD`/`XREAD BLOCK`, durable and replayable) and `makeWebSocketBroker` over any relay that rebroadcasts frames to all peers — the Cloudflare Durable Object pattern, where each Worker isolate holds a socket to the DO. Malformed payloads are skipped, never failed: correctness still rides on pull.
- **CVR**: `Cvr.makeKeyValueStore` persists client view records to a `KeyValueStore`. Back it with shared storage (Redis, SQL, a DO's storage) and every instance reads the same CVRs, so cookies are portable across instances. CVR storage stays ephemeral-tolerant — an unrecognised cookie degrades to a reset (ADR-0008), so eviction/TTL is the backing store's concern.
- **Tab liveness**: the tab-mirror protocol gains a `Heartbeat`. The host tracks each tab's last-seen time (refreshed by subscribes and heartbeats) and a sweep fiber reclaims subsets from tabs silent past `tabTimeout`. `TabMirror` heartbeats on an interval shorter than the timeout; an orderly `Disconnect` still releases immediately.

## Consequences

- A two-instance deployment is now just: serialized bus over a shared broker + KeyValueStore CVR over shared storage. Both are exercised by tests (a write on instance A pokes a session on instance B; a cookie minted by A is recognised by B).
- The broker interface is deliberately tiny, so a Durable Object, Redis, Postgres LISTEN/NOTIFY, or NATS becomes a distributed bus by implementing one method pair. The trade-off is that the broker is best-effort by contract (no delivery guarantee) — acceptable because the poke is only a latency optimisation over pull.
- Redis Streams replay from `"$"` means a reconnecting subscriber sees only future hints; `"0"` replays the stream (bounded only by the app's stream trimming). Pub/sub-style "only new" is the default.
- The heartbeat adds steady tab→host chatter (one tiny message per interval per tab) in exchange for bounded reclamation of crashed tabs' subscriptions; the interval/timeout are tunable. Crash reclamation is eventual (within `tabTimeout + sweepInterval`), never immediate.
