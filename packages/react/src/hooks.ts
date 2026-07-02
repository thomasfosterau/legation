/**
 * React hooks
 *
 * Thin bindings over `effect/unstable/reactivity` atoms. `useAtomValue`
 * subscribes a component to an atom via `useSyncExternalStore` (the
 * registry's `subscribe`/`get` are exactly that contract); `useAtomSet`
 * returns a writer. `useQuery` / `useNamedQuery` / `useMutation` select the
 * engine's atoms (`EngineAtoms`) and read/write them through those two
 * primitives — no bespoke reactivity here.
 */
import * as React from "react";
import { Effect } from "effect";
import { AtomRegistry, type Atom } from "effect/unstable/reactivity";
import type { ClientEngine, EngineAtoms, Subset } from "@legation/effect";
import { useEngineAtoms, useRegistry } from "./registry.js";

/** Subscribe to an atom's value, re-rendering whenever it changes. */
export const useAtomValue = <A>(atom: Atom.Atom<A>): A => {
  const registry = useRegistry();
  const subscribe = React.useCallback(
    (onChange: () => void) => registry.subscribe(atom, onChange),
    [registry, atom]
  );
  const snapshot = React.useCallback(() => registry.get(atom), [registry, atom]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

/** A writer for a writable atom (e.g. a mutation atom). */
export const useAtomSet = <R, W>(atom: Atom.Writable<R, W>): ((value: W) => void) => {
  const registry = useRegistry();
  return React.useCallback((value: W) => registry.set(atom, value), [registry, atom]);
};

/** Live result of a subset as an `AsyncResult`, re-rendering on every local change. */
export const useQuery = (subset: Subset.Subset): EngineAtoms.LiveQueryResult =>
  useAtomValue(useEngineAtoms().liveQuery(subset));

/** Live result of a named query (Query.ts) as an `AsyncResult`. */
export const useNamedQuery = (name: string, args: unknown): EngineAtoms.NamedQueryResult =>
  useAtomValue(useEngineAtoms().namedQuery(name, args));

/**
 * A mutate function for event handlers. Writing the mutation atom runs the
 * mutator optimistically; observe `EngineAtoms.mutation` if you need its
 * in-flight/error state.
 */
export const useMutation = (): ((mutator: string, args: unknown) => void) => {
  const set = useAtomSet(useEngineAtoms().mutation);
  return React.useCallback((mutator: string, args: unknown) => set({ mutator, args }), [set]);
};

/**
 * A mutate function that resolves with the mutation's authoritative outcome
 * (applied or permanently rejected) once the backend settles it. Runs
 * `mutateWithAck` on the engine runtime and awaits its acknowledgement; the
 * returned promise never rejects on a permanent rejection — inspect the
 * `MutationOutcome` instead. Use {@link useMutation} for fire-and-forget writes.
 */
export const useMutationWithAck = (): ((
  mutator: string,
  args: unknown
) => Promise<ClientEngine.MutationOutcome>) => {
  const registry = useRegistry();
  const atom = useEngineAtoms().mutationWithAck;
  return React.useCallback(
    (mutator: string, args: unknown) => {
      registry.set(atom, { mutator, args });
      return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));
    },
    [registry, atom]
  );
};
