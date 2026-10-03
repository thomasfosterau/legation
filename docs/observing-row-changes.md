# Observing row-level changes

`observe(subset)` gives you pages: the whole window, every time anything in
it changes. That's the right shape for most reads, but three consumers want
row-level deltas instead of a fresh array to diff by hand:

- a keyed list binding (Svelte 5's keyed `{#each}`, enter/exit animations)
  that wants "row 17 entered, row 3 left", not a new array;
- a side-effect subscription — notify an external system, log an audit
  event — that should fire once per row transition, not once per page;
- a pipeline that wants delta inputs rather than page snapshots.

`observeChanges` answers this: an `enter`/`update`/`exit` stream anchored to
the same subset a paired `observe(subset)` would page.

## The shape

```ts
type RowChange<Row> =
  | { _tag: "enter"; row: Row; position?: string }
  | { _tag: "update"; row: Row; previous: Row; position?: string }
  | { _tag: "move"; row: Row; position: string; previousPosition: string }
  | { _tag: "exit"; id: string; previous: Row }
  | { _tag: "reset" };
```

`enter`/`exit` are **anchored to the subset's result**, not its whole
matching set: a predicate crossing (an edit that makes a row start/stop
matching `where`) or a limit-boundary crossing (an insert pushing the last
visible row out, a delete pulling the next one in) both produce the same
enter/exit pair a consumer diffing two `observe()` pages by hand would
derive. `update` marks a row that stayed in the window but whose value
changed.

Batches are **per view-step** — one array per underlying view change, same
granularity as one `observe()` page re-emission — not per patch op. A quiet
window emits nothing; there's no need to filter empty arrays yourself.

### Position and `move`

`enter`, `update`, and `move` carry the row's stable `position` — a
{@link FractionalIndex} sort key the maintained window has assigned to it
(issue #112), present whenever the source can compute one. A row whose
`value` is unchanged but whose neighbors shifted enough to move it (a
sibling entering/leaving the window re-ranks it) emits `move` — `position`
and `previousPosition` — instead of being silently dropped as "unchanged."

A consumer that only needs membership and value can ignore `position`/`move`
entirely (a `move` never changes `value`). A keyed-list binding that wants
correct ordering uses `position` to place `enter`s and re-sort on `move`,
rather than only appending — see the Svelte example below.

`position` is present on `ClientEngine.observeChanges` (backed by `LiveView`'s
incrementally-maintained window). `Mirror.observeChanges` does not emit it: a
mirror has no maintained window of its own — it diffs consecutive whole-page
broadcasts from its host — so it cannot derive a stable position from a page
snapshot alone. This is a documented gap, not a silent one; a mirror-backed
consumer that needs order still re-derives it from a paired `observe` page.

### `reset`

Some transitions can't be diffed: a `Rebuild` (the optimistic overlay
shifted and any row in the window might have moved) or a seq-gap collapse (a
bounded change hub dropped one or more changes — see CONTEXT.md's hub
backpressure table). Both cases emit a single batch: a `reset` marker
followed by fresh `enter`s for every row currently in the window. Treat
`reset` as "clear whatever you were holding for this stream, then apply the
`enter`s that follow in the same batch" — never as a signal to special-case
skip.

### `includeInitial`

By default the stream is silent until the first live change. Pass
`{ includeInitial: true }` to get the current window as `enter`s in the
first batch — useful for a fresh subscriber that wants one code path for
"build the initial list" and "apply subsequent deltas" instead of seeding
from `query()` separately.

```ts
engine.observeChanges(todos, { includeInitial: true });
```

A late subscriber (one that starts after rows already exist) sees exactly
one batch of `enter`s for the current window — no gap, no duplicate row.

### What's not here yet

`Mirror.observeChanges` does not emit `position`/`move` (see above) — a
mirror-backed consumer that needs order re-derives it from a paired
`observe()` call.

## Where it lives

`observeChanges` is on the engine and the `ClientView` seam (ADR-0021), so it
works identically whether the engine runs in this thread or is hosted
elsewhere (a service worker, an Electron main process) behind a `Mirror`:

```ts
import { ClientEngine, ClientView, Mirror } from "@thomasfosterau/legation-effect/internal";

// Same call, either host:
engine.observeChanges(subset, options);
mirror.observeChanges(subset, options);
view.observeChanges(subset, options); // ClientView.fromEngine or a Mirror
```

A `ClientEngine` diffs its incrementally-maintained `LiveView` window
directly, so its batches carry `position`. A `Mirror` has no local `LiveView`
— it diffs consecutive whole-page updates the host already broadcasts to it,
which is exact for membership/value because the host sends the full current
page on every change; the two hosts emit identical `enter`/`update`/`exit`/
`reset` batches for identical page transitions, but only `ClientEngine`
emits `position`/`move` (see above).

## A keyed-list binding (Svelte 5 example)

The raw `Stream` is the framework primitive — bindings fold it into
whatever state shape the framework wants. For a Svelte 5 keyed `{#each}`,
that's a `$state` array kept in sync by applying each batch in order,
inserting/re-sorting by `position` when it's present and falling back to
append order when it's not (a mirror-backed source):

```svelte
<script lang="ts">
  import { Effect, Stream } from "effect";
  import * as FractionalIndex from "@thomasfosterau/legation-effect/internal/FractionalIndex";
  import type { Todo } from "./schema";

  interface Row {
    id: string;
    value: Todo;
    position?: string;
  }

  let todos = $state<Array<Row>>([]);

  // Insert/re-sort by `position` when present (ascending FractionalIndex
  // order); a row with no position keeps whatever order it was seen in.
  const bySortKey = (a: Row, b: Row): number =>
    a.position !== undefined && b.position !== undefined
      ? FractionalIndex.compare(a.position, b.position)
      : 0;

  $effect(() => {
    const applyBatch = (batch: ReadonlyArray<RowChange<Row>>) => {
      for (const change of batch) {
        switch (change._tag) {
          case "reset":
            todos = [];
            break;
          case "enter":
            todos = [...todos, { ...change.row, position: change.position }].toSorted(bySortKey);
            break;
          case "update":
            todos = todos
              .map((row) =>
                row.id === change.row.id ? { ...change.row, position: change.position ?? row.position } : row
              )
              .toSorted(bySortKey);
            break;
          case "move":
            todos = todos
              .map((row) => (row.id === change.row.id ? { ...row, position: change.position } : row))
              .toSorted(bySortKey);
            break;
          case "exit":
            todos = todos.filter((row) => row.id !== change.id);
            break;
        }
      }
    };

    const fiber = Effect.runFork(
      Stream.runForEach(client.observeChanges(todosSubset, { includeInitial: true }), (batch) =>
        Effect.sync(() => applyBatch(batch))
      )
    );
    return () => Effect.runFork(fiber.interruptAsFork(fiber.id));
  });
</script>

{#each todos as todo (todo.id)}
  <TodoRow {todo} />
{/each}
```

Because `update`/`move` only replace the row whose id matches (re-sorting the
array reference, not each row object), Svelte's keyed `{#each}` still only
re-renders rows whose own identity/props changed — no `transition:` restart on
rows that merely shifted position in the DOM order.

## Side-effect subscriptions

The `createEffect`-style pattern (notify an external system per row
transition) is a `Stream.runForEach` over the batches — small enough that it
isn't worth its own wrapper:

```ts
Stream.runForEach(client.observeChanges(subset), (batch) =>
  Effect.forEach(batch, (change) => {
    switch (change._tag) {
      case "enter":
        return notifyEntered(change.row);
      case "exit":
        return notifyExited(change.id);
      case "update":
        return notifyUpdated(change.row, change.previous);
      case "move":
        return Effect.void; // position only; value is unchanged
      case "reset":
        return Effect.void; // resync, no per-row notification
    }
  })
);
```
