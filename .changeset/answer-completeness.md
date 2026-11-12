---
"@thomasfosterau/legation": minor
---

Mark a `Client` answer that the replica gave for an uncovered read as partial (#653). `Client.completenessOf(rows)` returns `Option.some("complete")` for rows from a covered or server-answered `Client.query`, `Option.some("partial")` for an uncovered read the replica answered (offline, or over a transport without `read`), and `Option.none()` for an array no Client answered with. Each array `Client.observe` emits is marked the same way: partial until the read's windows are pulled, then emitted again as complete. The marker sits beside the rows, so the result's type and shape are unchanged, and a Svelte `useQuery` result's rows carry it too. `ClientView` gains an optional `pulledChanges` stream that the Client uses to re-judge a live read after a pull, and an engine-backed view's relational read now records pull marks under its relational key, as a pin with `include` does.
