---
"@thomasfosterau/legation-effect": patch
---

Fix paced compaction stranding the journal behind a mutation-id gap (#249).
`Paced.coalesce`/`debounce`/`throttle` drop superseded unpushed entries, which
left holes in the client's mutation ids. Both reference backends reject a gap
(ADR-0008's exactly-once ledger), so every push failed and the journal never
drained. The client now renumbers: `ClientEngine.dropIfPending` drops the
entries and renumbers the surviving unpushed ones contiguously, in order, from
the last entry a push may have sent (or from the first pending id), rewinding
the id counter to match. The backends are unchanged and still reject gaps.

- `dropIfPending` now returns `{ dropped, renumbered }` (was the dropped ids),
  and `Paced` applies the moves to every paced instance on the engine so none
  acts on an id that now names a different entry.
- Safety: compaction never touches an entry a push attempt may have sent. The
  engine records a durable per-client "sent" watermark (`ClientStore.markSent`)
  before each push leaves, so a push whose response was lost keeps its ids
  (renumbering an applied write would get a later one skipped as a duplicate).
  It still refuses while a push is in flight, and runs under the journal lock so
  it is atomic with `mutate` and with a push claiming the pending set.
- `ClientStore.dropPending` (unreleased) is replaced by `compactPending`
  (drop + renumber + counter rewind, as one step) and `markSent`. The
  KeyValue store does this through a write-ahead intent that is rolled forward
  on the next open, so a crash never leaves a gap, a duplicate or a stale
  counter. Custom `ClientStore` implementations must provide both.
- `mutateWithAck` handles and `mutationStates` follow renumbered entries, a
  dropped entry's `acknowledged` effect is interrupted instead of leaking, and
  `engineEvents` gains `MutationRenumbered`. `MutationHandle.mutationId` is the
  id at journal time and can change while the entry is unpushed.
