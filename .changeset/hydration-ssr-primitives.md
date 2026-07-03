---
"@legation/effect": minor
---

SSR primitives in `Hydration` (ADR-0020): `snapshot` produces a page snapshot
over a request-scoped engine (in-memory store + in-process transport to the
in-context `ServerHandler`, subscribe → pull → dehydrate) under the browser's
client group id, so the snapshot cookie continues that group's CVR
conversation on the client's first pull; `isEmpty` / `hydrateIfEmpty` gate
client boot so a stale snapshot never regresses a durable store's cookie or
journalled offline mutations; `rowsFor` projects a snapshot onto a subset
with `Subset.apply` — the synchronous initial value for component hooks
during SSR and first client render.
