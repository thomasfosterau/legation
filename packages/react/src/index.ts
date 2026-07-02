/**
 * @legation/react
 *
 * Idiomatic React bindings for the legation engine, built as a thin layer
 * over `effect/unstable/reactivity` atoms: `EffectSyncProvider` supplies an
 * `AtomRegistry` and the engine's atoms (`EngineAtoms.fromLayer`); `useQuery`
 * / `useNamedQuery` expose live `AsyncResult`s via `useSyncExternalStore`; and
 * `useMutation` writes the mutation atom. `useAtomValue` / `useAtomSet` are
 * exposed for binding any other atom.
 */
export * from "./registry.js";
export * from "./hooks.js";
