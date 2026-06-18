# @thomasfosterau/effect-sync-react

Idiomatic React bindings for the
[`@thomasfosterau/effect-sync-core`](../core) engine — a thin layer over
`effect/unstable/reactivity` atoms.

- **`<EffectSyncProvider atoms={…} registry={…?}>`** — supplies the engine's
  atoms (`EngineAtoms.fromLayer(engineLayer)`) and an `AtomRegistry` (created
  for you if omitted). The registry owns the engine's scope.
- **`useQuery(subset)`** / **`useNamedQuery(name, args)`** — the live result as
  an `AsyncResult` (initial / success / failure), bound to its atom via
  `useSyncExternalStore`; the component re-renders on every local change and
  the subscription is shared and reclaimed automatically.
- **`useMutation()`** — returns `mutate(name, args)` that writes the mutation
  atom (optimistic); observe `EngineAtoms.mutation` for in-flight/error state.
- **`useAtomValue(atom)`** / **`useAtomSet(atom)`** — bind any other atom.

```bash
npm install @thomasfosterau/effect-sync-react @thomasfosterau/effect-sync-core effect react
```
