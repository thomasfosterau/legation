---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-svelte": minor
---

Add `Undo`: an optional, additive undo/redo module layered over anything that
can `mutate(name, args)` — no engine surgery. It follows the **paired-intents**
design (the `@rocicorp/undo` shape): the caller supplies both directions of a
change — an `execute` intent and its reversing `undo` intent — and
`Undo.make(handle)` returns an `UndoManager` whose `run` / `undo` / `redo`
replay through the handle's ordinary `mutate` pipeline. A `ClientEngine` and a
`Client` both satisfy the accepted `MutateHandle` shape structurally; because
their `mutate` methods don't share an error channel, both `MutateHandle` and
`UndoManager` are generic in that error type, so a failed mutation is still
observable as whatever the supplied handle fails with. Because undo and redo
are just mutations, they are optimistic, journaled, rebased, and offline-safe
like any write; the module only owns the history.

History is **in-memory and per-client** (one manager per engine, a pair of
stacks in a `SubscriptionRef`) — it does not survive a reload, though the
journal still carries any pending undo/redo mutations to the backend. `run`
clears the redo stack (a new action invalidates redo); `undo` and `redo` are
no-ops (never errors) when their stack is empty. `group(effect)` coalesces every
`run` made while `effect` runs into a single step: one `undo` replays each
member's `undo` in reverse order, one `redo` replays each member's `execute` in
order. `canUndo` / `canRedo` are one-shot effects; `canUndoChanges` /
`canRedoChanges` are `SubscriptionRef.changes`-backed streams for bindings.

The **delete-then-undo** criterion is met by the paired-intents pattern: capture
the row's pre-delete value from the local view at run time and pass it as the
undo's re-create args, so an undo restores the row exactly.

`@thomasfosterau/legation-svelte` gains `useUndo(manager)` — `canUndo` / `canRedo` as runes
over the manager's change streams, plus `undo` / `redo` handlers. The `todo`
example wires ⌘Z / Ctrl+Z (Shift for redo) through the manager and documents
the recipe.
