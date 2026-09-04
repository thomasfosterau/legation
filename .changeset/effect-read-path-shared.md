---
"@legation/effect": patch
---

ADR-0025's read path is reusable outside the protocol carrier (#163).
`SyncServer.readSubsets(deps, context, request)` is `handleRead` without the
identity resolution: the filterable check, `SyncMiddleware.onRead`, the
deny-by-default auth filters, then `Backend.evaluate` + `getRows` per subset;
`handleRead` calls it, and the derived REST handlers in `@legation/jsonapi`
call it behind an HTTP request's identity. Every subset of a batch is
authorized before any is evaluated, as `handleRead` always did, and the rows
of each subset now come back in the evaluated order (`getRows` promises
none), so a fallthrough read over a SQL backend is windowed exactly as
`Subset.apply` orders it. `Query.runVia(fetch, nodes, read)` runs a read over
an external row source — the plan, `Related.queryVia`'s two phases, and the
edge windows — and `Query.runPlanVia(fetch, nodes, plan)` does the same over
an already-compiled plan; `Client.query`'s server fallthrough compiles once
and uses the latter.
