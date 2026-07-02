---
"@legation/effect": minor
---

Write-path incremental view maintenance. A `mutate` and a push acknowledgement now carry the collections they touch, so a live query observing a different collection no longer re-materialises when an unrelated collection changes; the collections are discovered by running the mutator's local handler through a lightweight collection-tracking writer. The materialised optimistic overlay is cached and shared across observers (invalidated on every journal append/trim and pull), so a single change costs one journal replay rather than one per observer. `LiveView.put`/`del` gain an id index: an absent id is now an O(1) no-op and an existing row is located by binary search on its sort key (O(log n) for distinct sort keys, O(log n + equal-key run) on ties) instead of a linear scan. A checked-in benchmark (`bun run bench`) exercises a mutation burst over a large collection with many observers.

Targeted overlay-delta recomputation on pull-with-pending remains staged: a pull while the journal is non-empty still falls back to a global rebuild, preserving rebase correctness.
