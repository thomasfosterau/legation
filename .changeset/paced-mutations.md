---
"@legation/effect": minor
---

Paced mutations (#117): `Paced.debounce`/`Paced.throttle`/`Paced.coalesce`
(`@legation/effect/internal`) pace rapid mutation intents — a text field
autosaving per keystroke, a slider, a cart-quantity stepper — into a handful
of journal entries instead of one per call, built entirely on
`ClientEngine.mutateWithAck` and Effect's own timing primitives (no new
dependency, no general-purpose pacer module).

Design: every call always journals immediately through the ordinary
`mutateWithAck` path (full durability, the usual optimistic overlay render),
then a compaction step drops the caller's own previous still-pending entry
for the same key via the new `ClientEngine.dropIfPending`. `debounce`/
`throttle` additionally buffer intermediate calls in memory between a leading
and a trailing/periodic flush, so a 50-call burst produces at most a couple of
journal writes — the tradeoff being that the buffered args between flushes
are lost on a crash inside the window (`coalesce` has no such window: every
call is durable, at the cost of short-lived extra entries before the next
call's compaction).

`dropIfPending` never touches an entry a `push` may already have sent:
`ClientStore.dropPending` (a new store primitive, symmetric to `acknowledge`
but by explicit id set) only ever removes ids the engine has confirmed are
still in its pending set with no push currently in flight — the ADR-0008 hard
boundary (never mutate or reorder a pushed journal entry) is enforced inside
the engine, not trusted to callers.
