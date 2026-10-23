---
"@thomasfosterau/legation-jsonapi": minor
---

The JSON:API façade intercepts writes (ADR-0030 §1, §3, §5, #510). Given the
engine's journal seam (`mutate`, the worker engine's `mutateWithAck`), a
`POST` with a client id, a `PATCH` or a `DELETE` on a reflected write route is
journaled as the graph-derived CRUD mutation and answered `202 Accepted` with a
write receipt — the resource as journaled, `meta.legation.status: "pending"`
and a `Location` naming the mutation status URL — when offline, when the
forward rejected at the transport, or on `Prefer: respond-async`
(`Preference-Applied: respond-async`). Online and unasked, writes are
forwarded unchanged and journal nothing; `Prefer: handling=strict` never
journals. New options `mutate`, `intentOf` (default
`FacadeWrites.graphIntentOf(nodes)`), `writes` and `pull`; new
`FetchHandler.forwarded(request, response)`, which signals `pull` after a
`2xx` forwarded write.

**Breaking:** `FetchHandler.offline` is now a function of the request,
`offline(request)`: a write candidate is journaled and answered with its
receipt (pass the clone taken before forwarding), anything else gets the 503
`offline` document as before. Replace `facade.offline` with
`facade.offline(request)`.
