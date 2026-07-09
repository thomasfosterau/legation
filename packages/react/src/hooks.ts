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
import { AsyncResult, AtomRegistry, type Atom } from "effect/unstable/reactivity";
import type { ClientEngine, EngineAtoms, MutationState, Subset } from "@legation/effect/internal";
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

/** Options shared by {@link useQuery} and {@link useNamedQuery}. */
export interface QueryOptions<A> {
  /**
   * Keep the previous subset's rows on screen as a `waiting` `Success` while
   * a changed subset (a different `Subset.hash`, or different name/args)
   * loads, instead of dropping to `Initial`. Mirrors the Svelte binding's
   * resubscribe semantics (`useLiveStream`) — this binding's equivalent of
   * TanStack's `placeholderData: keepPreviousData`. The consumer
   * discriminates previous ("stale") from fresh data via
   * `AsyncResult.isWaiting`.
   */
  readonly keepPrevious?: boolean;
  /**
   * Seed the hook's first render with a synchronous `Success` before the
   * live query has emitted — e.g. server-fetched or prefetched rows, so the
   * first paint isn't a loading flash. Only applies before the first real
   * emission; matches the Svelte binding's `initial`.
   */
  readonly initial?: A;
}

/**
 * Derives the value a live-query hook renders from the underlying atom's raw
 * `AsyncResult`, applying `initial` seeding and `keepPrevious` carry-forward
 * across an atom-identity change (a changed subset hash, or changed
 * name/args, selects a different atom). Mutating the ref during render (not
 * in an effect) is required: the carried-forward value must be ready for
 * this same render, or the changed-subset render would flash `Initial`.
 *
 * A live-query atom's `Success` is always `waiting: true` (`Atom`'s stream
 * constructor marks every pull of a never-ending source waiting — there is
 * always more to come); settling it to `waiting: false` here is what makes
 * `waiting` mean "this is carried-over previous data" rather than "this is a
 * live subscription", so `keepPrevious` has a real (non-ambient) flag to set.
 */
function useLiveResult<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: QueryOptions<A>
): AsyncResult.AsyncResult<A, E> {
  const raw = useAtomValue(atom);
  const settled = AsyncResult.isSuccess(raw)
    ? AsyncResult.success(raw.value, { timestamp: raw.timestamp })
    : raw;
  const ref = React.useRef<
    | {
        readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
        readonly result: AsyncResult.AsyncResult<A, E>;
      }
    | undefined
  >(undefined);
  const prev = ref.current;

  let result: AsyncResult.AsyncResult<A, E>;
  if (prev === undefined) {
    result =
      AsyncResult.isInitial(settled) && options?.initial !== undefined
        ? AsyncResult.success(options.initial)
        : settled;
  } else if (prev.atom !== atom) {
    result =
      options?.keepPrevious === true &&
      AsyncResult.isSuccess(prev.result) &&
      AsyncResult.isInitial(settled)
        ? AsyncResult.waiting(prev.result)
        : settled;
  } else {
    result = AsyncResult.isInitial(settled) ? prev.result : settled;
  }

  ref.current = { atom, result };
  return result;
}

/**
 * Live result of a subset as an `AsyncResult`, re-rendering on every local
 * change. A {@link Subset.TypedSubset} refines the rows to its row type; a
 * plain `Subset` returns untyped rows. `options.keepPrevious` and
 * `options.initial` — see {@link QueryOptions}.
 */
export function useQuery<A>(
  subset: Subset.TypedSubset<A>,
  options?: QueryOptions<ReadonlyArray<ClientEngine.TypedRow<A>>>
): EngineAtoms.TypedLiveQueryResult<A>;
export function useQuery(
  subset: Subset.Subset,
  options?: QueryOptions<ReadonlyArray<ClientEngine.LocalRow>>
): EngineAtoms.LiveQueryResult;
export function useQuery(
  subset: Subset.Subset,
  options?: QueryOptions<ReadonlyArray<ClientEngine.LocalRow>>
): EngineAtoms.LiveQueryResult {
  return useLiveResult(useEngineAtoms().liveQuery(subset), options);
}

/** Live result of a named query (Query.ts) as an `AsyncResult`. */
export const useNamedQuery = (
  name: string,
  args: unknown,
  options?: QueryOptions<ReadonlyArray<ClientEngine.LocalRow>>
): EngineAtoms.NamedQueryResult => useLiveResult(useEngineAtoms().namedQuery(name, args), options);

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

/**
 * Reactive mutation-state list (#116) — TanStack Query's `useMutationState`
 * analogue: every journaled mutation's current lifecycle state (`pending` →
 * `acknowledged` | `rejected`), oldest-journaled first. Pass `mutator` to
 * scope to one mutator (`EngineAtoms.mutationsFor`); omit it for every
 * mutation (`EngineAtoms.mutationStates`). Always an array — empty before the
 * engine's first emission — so a "N unsent changes" badge or a failed-intents
 * list needs no `AsyncResult` handling.
 */
export const useMutationState = (mutator?: string): ReadonlyArray<MutationState.MutationState> => {
  const atoms = useEngineAtoms();
  const atom: Atom.Atom<EngineAtoms.MutationStatesResult | EngineAtoms.MutationsForResult> =
    mutator === undefined ? atoms.mutationStates : atoms.mutationsFor(mutator);
  const result = useAtomValue(atom);
  return React.useMemo(() => {
    // `result`'s shape is determined by the same `mutator === undefined`
    // check that selected its source atom above, so these casts are safe:
    // the whole-map atom's `AsyncResult` always resolves to a Map, the
    // per-mutator atom's always resolves to an already-filtered array.
    if (mutator === undefined) {
      const map = AsyncResult.getOrElse(
        result as EngineAtoms.MutationStatesResult,
        () => new Map<number, MutationState.MutationState>()
      );
      return [...map.values()].toSorted((a, b) => a.mutationId - b.mutationId);
    }
    return AsyncResult.getOrElse(result as EngineAtoms.MutationsForResult, () => []);
  }, [result, mutator]);
};
