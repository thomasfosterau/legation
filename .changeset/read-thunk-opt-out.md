---
"@legation/svelte": minor
---

Every rune hook that takes a read thunk (`useQuery`, `useConnection`, `useNamedQuery`, `useAggregate`, `useAggregateGrouped`) lets the thunk return `undefined` to opt out — "no read right now," for a read keyed on a selection that starts empty. No window is registered and no request is issued, and `current` stays at its initial state rather than becoming a `Success` over zero rows, so an opted-out read stays distinguishable from one that legitimately matched nothing. The thunk stays reactive either way: flipping the condition subscribes/unsubscribes with the same stale-while-revalidate behaviour as any other input change.

This replaces the sentinel-argument workaround (a read keyed on `id ?? ""` to make it match nothing) — the Northwind orders screen and the Conduit editor example both drop theirs in favor of returning `undefined`.
