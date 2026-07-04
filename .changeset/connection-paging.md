---
"@legation/svelte": minor
---

`useConnection` — connection-style paging over a read's root window (ADR-0024). `loadMore` widens the one window a page at a time rather than fetching detached pages, so each page's rows accumulate, the previous ones stay on screen through the widen (stale-while-revalidate), and the engine only ever syncs the current window — never the whole collection. The hook returns the live rows (`current`/`promise`) plus `loadMore()`, reactive `hasMore` and `loading`, and `reset()`, and seeds from SSR like the other `use*` hooks.

Per-parent paging falls out of instantiating the hook per parent: scope the read's `where` to a parent id and give each parent its own `useConnection` (one per `{#each}` row), and each parent's list pages independently. The passed read's own `first`/`after` are ignored — the hook owns the window — and the read thunk stays reactive, re-basing to the first page when its base changes.
