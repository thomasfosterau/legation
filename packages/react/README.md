# @legation/react

Idiomatic React bindings for the
[`@legation/effect`](../effect) engine — a thin layer over
`effect/unstable/reactivity` atoms.

Coming from TanStack Query / SwiftData / SWR? [Coming from TanStack Query](../../docs/coming-from-tanstack-query.md) maps those libraries' concepts onto this model.

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
npm install @legation/react @legation/effect effect react
```
