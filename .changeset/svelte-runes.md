---
"@legation/svelte": minor
---

Add a rune-based API for Svelte 5 at `@legation/svelte/runes`: `useQuery`,
`useNamedQuery`, `useAggregate`, `useAggregateGrouped`, `useRelated` (with an
auto-subscribing `subscribe: true` variant) and `useMutation` /
`useMutationWithAck`. Hooks take their inputs as thunks tracked by `$effect`,
so a query re-subscribes when its reactive inputs change (e.g. a `$state`
pagination cursor) — something the store API cannot express — and expose a
reactive `current` `AsyncResult` with stale-while-revalidate `waiting`
semantics, matching the engine's reactivity atoms and the React binding.
Every live hook accepts `{ initial }` to seed a synchronous `Success` before
the first emission — what SSR renders, and what makes the first client render
match the server markup. The store API on the package root is unchanged and
remains Svelte-4 compatible.
