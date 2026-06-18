# @thomasfosterau/effect-sync-react

Idiomatic React bindings for the
[`@thomasfosterau/effect-sync-core`](../core) engine.

- **`<EffectSyncProvider runtime={…}>`** — supplies a `ManagedRuntime` that can
  run `ClientEngine` effects (build it from `JsonApiSync.layer` or a core
  composition).
- **`useQuery(subset)`** / **`useNamedQuery(name, args)`** — live results via
  `useSyncExternalStore`; the component re-renders on every local change (a
  forked `observe` fiber is torn down when the last subscriber unmounts).
- **`useMutation()`** — returns a promise-returning `mutate(name, args)` for
  event handlers (optimistic on resolve).

```bash
npm install @thomasfosterau/effect-sync-react @thomasfosterau/effect-sync-core effect react
```
