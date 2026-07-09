---
"@legation/effect": minor
---

`observeAggregate` / `observeAggregateGrouped` now maintain their fold
incrementally from row-level deltas instead of re-scanning the subset on
every emission (#110). `Count`/`Sum`/`Avg` update in O(1) per row delta
(`Avg` as a running `{sum, count}`); `Min`/`Max` update in O(1) except when
the row removed or updated away held the current extremum, in which case
only the surviving values are refolded. Grouped aggregates touch only a
changed row's old and new group — every other group's value is left
untouched, both in cost and by reference.

This applies to unwindowed subsets (no `limit`/`cursor` — the common case:
aggregating over everything a client has synced) whenever a `Patch` view
change is available — a confirmed pull's per-row deltas, or (now that #109
has landed) a `mutate`'s optimistic overlay deltas. A windowed subset, or a
change too large to diff safely (`Rebuild` — resets, an unrecognized
mutator, seq-gap collapses), still refolds from scratch, as before. Public
API and dedup guarantees ("streams do not re-emit when a change leaves the
aggregate unchanged") are unchanged.

A benchmark (`bun run bench`) exercises three live aggregates over a 10k-row
collection under single-row churn.
