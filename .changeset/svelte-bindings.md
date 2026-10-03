---
"@thomasfosterau/legation-svelte": minor
---

New package `@thomasfosterau/legation-svelte`: idiomatic Svelte bindings. `setClientRuntime`
supplies the `ManagedRuntime` carrying the `Client`; the rune hooks
(`useQuery` / `useConnection` / `useNamedQuery` / `useAggregate` /
`useAggregateGrouped` / `useMutation` / `useMutationWithAck` /
`useMutationState` / `useUndo`) are the whole read/write surface, each taking
its inputs as a thunk so a read re-subscribes when the reactive state it
touches changes. Extends the framework-bindings coverage (#25) to Svelte.
