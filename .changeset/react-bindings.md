---
"@thomasfosterau/effect-sync-react": minor
---

New package `@thomasfosterau/effect-sync-react`: idiomatic React bindings.
`<EffectSyncProvider>` supplies a `ManagedRuntime` running `ClientEngine`
effects; `useQuery` / `useNamedQuery` render live results via
`useSyncExternalStore` (a forked `observe` fiber per query, torn down on
unmount); `useMutation` returns a promise-returning mutate function for event
handlers. Closes the framework-bindings gap (#25).
