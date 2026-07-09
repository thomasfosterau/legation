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
  | { _tag: "enter"; row: Row }
  | { _tag: "update"; row: Row; previous: Row }
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

Ordering (a `move` variant with a stable position key) needs incrementally
maintained position identity, tracked separately (issue #112). Until that
lands, a consumer that needs order re-derives it from a paired `observe()`
call or from the position `enter`s arrive in within a batch — `observeChanges`
alone tells you membership and value, not position.

## Where it lives

`observeChanges` is on the engine and the `ClientView` seam (ADR-0021), so it
works identically whether the engine runs in this thread or is hosted
elsewhere (a service worker, an Electron main process) behind a `Mirror`:

```ts
import { ClientEngine, ClientView, Mirror } from "@legation/effect/internal";

// Same call, either host:
engine.observeChanges(subset, options);
mirror.observeChanges(subset, options);
view.observeChanges(subset, options); // ClientView.fromEngine or a Mirror
```

A `ClientEngine` diffs its incrementally-maintained `LiveView` window
directly. A `Mirror` has no local `LiveView` — it diffs consecutive whole-page
updates the host already broadcasts to it, which is exact because the host
sends the full current page on every change; the two hosts emit identical
batches for identical page transitions.

## A keyed-list binding (Svelte 5 example)

The raw `Stream` is the framework primitive — bindings fold it into
whatever state shape the framework wants. For a Svelte 5 keyed `{#each}`,
that's a `$state` array kept in sync by applying each batch in order:

```svelte
<script lang="ts">
  import { Effect, Stream } from "effect";
  import type { Todo } from "./schema";

  let todos = $state<Array<{ id: string; value: Todo }>>([]);

  $effect(() => {
    const applyBatch = (batch: ReadonlyArray<RowChange<{ id: string; value: Todo }>>) => {
      for (const change of batch) {
        switch (change._tag) {
          case "reset":
            todos = [];
            break;
          case "enter":
            todos = [...todos, change.row];
            break;
          case "update":
            todos = todos.map((row) => (row.id === change.row.id ? change.row : row));
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

Because updates only replace the row whose id matches, Svelte's keyed
`{#each}` only re-renders the changed row — no full-list diff, no
`transition:` restart on unrelated rows.

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
      case "reset":
        return Effect.void; // resync, no per-row notification
    }
  })
);
```
