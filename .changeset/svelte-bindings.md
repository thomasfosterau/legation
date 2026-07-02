---
"@legation/svelte": minor
---

New package `@legation/svelte`: idiomatic Svelte bindings.
`setEngineRuntime` supplies a `ManagedRuntime` running `ClientEngine` effects;
`query` / `namedQuery` render live results as Svelte `Readable` stores (a forked
`observe` fiber per store, torn down when the last subscriber unsubscribes);
`getMutate` returns a promise-returning mutate function for event handlers. Pure
TypeScript (stores + `setContext`/`getContext`), so it builds with the same
`tsc -b` as the rest of the monorepo and works with Svelte 4 and 5. Extends the
framework-bindings coverage (#25) to Svelte.
