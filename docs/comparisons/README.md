# Comparisons

How legation relates to the other systems in the sync/local-first space —
one document per system, each honest about where the other side wins:

- [**Convex**](convex.md) — reactive backend platform; server-side
  reactivity vs a client-side replica over your own backend.
- [**Zero (Rocicorp)**](zero.md) — the closest relative; same
  mutation-log/rebase lineage, diverging on query model (ZQL vs subsets +
  composition), infrastructure (zero-cache vs a library), and client
  placement (main thread vs service worker).
- [**TanStack Query / TanStack DB**](tanstack.md) — the request-cache
  model vs the replica model, then two implementations of the replica
  model.
- [**Replicache + ElectricSQL**](replicache-electric.md) — the two halves
  (write path, read path) legation integrates, including the genealogy:
  ADR-0008 descends from Replicache's design.
- [**SwiftData + CloudKit / Room + Firestore**](swiftdata-room.md) — the
  native platforms' local-store-with-live-queries frameworks: the read
  model legation shares, the state-based last-writer-wins sync it doesn't,
  and the web-only platform reality (ADR-0012/0013 withdrawn; ADR-0017
  spec export for bespoke native clients).

Vocabulary in these documents follows [`CONTEXT.md`](../../CONTEXT.md);
the architecture decisions they cite live in [`docs/adr/`](../adr/). For a
hands-on translation aimed at TanStack Query / SWR / Apollo / SwiftData
users, see [`coming-from-tanstack-query.md`](../coming-from-tanstack-query.md).
