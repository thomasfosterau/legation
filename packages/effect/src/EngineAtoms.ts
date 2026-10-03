/**
 * EngineAtoms
 *
 * The engine's `effect/reactivity` Atom surface (ADR-0007): live
 * query and named-query atoms whose value re-emits on every local change,
 * plus a mutation atom for optimistic writes. Built over an `Atom.runtime`
 * from the engine layer, so the registry owns the engine's scope.
 *
 * Atoms are the UI surface. Framework packages (e.g. @thomasfosterau/legation-svelte) are
 * thin bindings over these — they mount an atom against an `AtomRegistry`,
 * they do not re-implement reactivity.
 *
 * For binding against a *resolved* observe-source instance (a `ClientEngine`
 * value, or a browser `Mirror`) rather than the engine layer, see
 * `LiveQuery`, which wraps `source.observe(subset)` with the registry's
 * default runtime.
 */

import type { Cause, Layer } from "effect";
import { Effect, HashMap, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AsyncResult, AtomRegistry, Reactivity } from "effect/reactivity";
import {
  ClientEngine,
  type LocalRow,
  type MutationOutcome,
  type TypedRow,
} from "./ClientEngine.js";
import * as Aggregate from "./Aggregate.js";
import type { MutatorError, QueryError, StoreError } from "./Errors.js";
import * as Hash from "./Hash.js";
import * as MutationState from "./MutationState.js";
import * as Subset from "./Subset.js";

type Rows = ReadonlyArray<LocalRow>;

/**
 * A live query's Atom value: the current rows as an `AsyncResult`. A
 * never-ending source stays `Success` after the first emission;
 * `NoSuchElementError` only appears if a source completes without emitting.
 */
export type LiveQueryResult = AsyncResult.AsyncResult<
  Rows,
  StoreError | MutatorError | Cause.NoSuchElementError
>;

/**
 * A typed live query's Atom value: the current rows refined to the row type
 * `A`, as an `AsyncResult`. `TypedLiveQueryResult<unknown>` is structurally
 * {@link LiveQueryResult}, so plain-subset callers are unaffected.
 */
export type TypedLiveQueryResult<A> = AsyncResult.AsyncResult<
  ReadonlyArray<TypedRow<A>>,
  StoreError | MutatorError | Cause.NoSuchElementError
>;

/** A named query's Atom value (adds `QueryError` to the failure channel). */
export type NamedQueryResult = AsyncResult.AsyncResult<
  Rows,
  StoreError | MutatorError | QueryError | Cause.NoSuchElementError
>;

/** A live aggregate's Atom value: the current aggregate value as an `AsyncResult`. */
export type AggregateResult = AsyncResult.AsyncResult<
  Aggregate.AggregateValue,
  StoreError | MutatorError | Cause.NoSuchElementError
>;

/** A live grouped-aggregate's Atom value: the per-group record as an `AsyncResult`. */
export type GroupedAggregateResult = AsyncResult.AsyncResult<
  Record<string, Aggregate.AggregateValue>,
  StoreError | MutatorError | Cause.NoSuchElementError
>;

/** What to write to the mutation atom to run a mutator optimistically. */
export interface MutationArg {
  readonly mutator: string;
  readonly args: unknown;
}

/** The mutation-state map's Atom value (#116): an `AsyncResult` of the current map. */
export type MutationStatesResult = AsyncResult.AsyncResult<
  MutationState.MutationStateMap,
  Cause.NoSuchElementError
>;

/** A `mutationsFor` selector's Atom value: the matching states, oldest first. */
export type MutationsForResult = AsyncResult.AsyncResult<
  ReadonlyArray<MutationState.MutationState>,
  Cause.NoSuchElementError
>;

/** The engine's reactive surface, built from its layer. */
export interface EngineAtoms {
  /** The runtime backing every engine atom; the registry owns its scope. */
  readonly runtime: Atom.AtomRuntime<ClientEngine, never>;
  /**
   * The Atom for a subset's live results. Stable per subset identity
   * (`Subset.hash`): the same subset yields the same Atom, so mounting it
   * from many components shares one subscription. A {@link Subset.TypedSubset}
   * refines the Atom's rows to its row type.
   */
  readonly liveQuery: {
    <A>(subset: Subset.TypedSubset<A>): Atom.Atom<TypedLiveQueryResult<A>>;
    (subset: Subset.Subset): Atom.Atom<LiveQueryResult>;
  };
  /** The Atom for a named query's live results, stable per (name, args). */
  readonly namedQuery: (name: string, args: unknown) => Atom.Atom<NamedQueryResult>;
  /**
   * The Atom for a subset's live aggregate value. Stable per
   * `(subset hash, aggregate)`, so mounting it from many components shares one
   * subscription. Re-emits only when the aggregate value changes.
   */
  readonly aggregate: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate
  ) => Atom.Atom<AggregateResult>;
  /** The Atom for a subset's live grouped aggregate, stable per `(subset hash, aggregate, groupBy)`. */
  readonly aggregateGrouped: (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate,
    groupBy: string
  ) => Atom.Atom<GroupedAggregateResult>;
  /** Write a {@link MutationArg} to run a mutator; its result is an `AsyncResult`. */
  readonly mutation: Atom.AtomResultFn<MutationArg, void, MutatorError | StoreError>;
  /**
   * The Atom for the engine's whole keyed mutation-state map (#116) —
   * `ClientEngine.mutationStates` re-emits on every fold; a single shared
   * Atom, so mounting it from many components shares one subscription.
   */
  readonly mutationStates: Atom.Atom<MutationStatesResult>;
  /**
   * A derived selector over {@link mutationStates}, filtered to one mutator
   * and sorted oldest-journaled first — "N unsent changes" or "list failed
   * intents" for one mutator in one line. Stable per `mutator`.
   */
  readonly mutationsFor: (mutator: string) => Atom.Atom<MutationsForResult>;
  /**
   * Like {@link mutation}, but its result resolves with the mutation's
   * authoritative outcome (applied or permanently rejected) once the backend
   * settles it — the atom stays `Waiting` until then. Backs `useMutationWithAck`.
   */
  readonly mutationWithAck: Atom.AtomResultFn<
    MutationArg,
    MutationOutcome,
    MutatorError | StoreError
  >;
}

/**
 * Build the engine's reactive surface from its layer. The layer must provide
 * `ClientEngine` with all of its own dependencies already satisfied —
 * `Atom.runtime` supplies only `AtomRegistry`/`Reactivity` and manages the
 * engine's scope for the registry's lifetime.
 */
export const fromLayer = (
  engineLayer: Layer.Layer<ClientEngine, never, AtomRegistry.AtomRegistry | Reactivity.Reactivity>
): EngineAtoms => {
  const runtime = Atom.runtime(engineLayer);

  const liveQueries = new Map<string, Atom.Atom<LiveQueryResult>>();
  const liveQuery = (subset: Subset.Subset): Atom.Atom<LiveQueryResult> => {
    const key = Subset.hash(subset);
    const existing = liveQueries.get(key);
    if (existing !== undefined) return existing;
    const atom = runtime.atom(
      Stream.unwrap(Effect.map(ClientEngine, (engine) => engine.observe(subset)))
    );
    liveQueries.set(key, atom);
    return atom;
  };

  const namedQueries = new Map<string, Atom.Atom<NamedQueryResult>>();
  const namedQuery = (name: string, args: unknown): Atom.Atom<NamedQueryResult> => {
    const key = `${name}:${Hash.canonicalJson(args)}`;
    const existing = namedQueries.get(key);
    if (existing !== undefined) return existing;
    const atom = runtime.atom(
      Stream.unwrap(Effect.map(ClientEngine, (engine) => engine.observeNamed(name, args)))
    );
    namedQueries.set(key, atom);
    return atom;
  };

  const aggregates = new Map<string, Atom.Atom<AggregateResult>>();
  const aggregate = (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate
  ): Atom.Atom<AggregateResult> => {
    const key = `${Subset.hash(subset)}:${Hash.canonicalJson(agg)}`;
    const existing = aggregates.get(key);
    if (existing !== undefined) return existing;
    const atom = runtime.atom(
      Stream.unwrap(Effect.map(ClientEngine, (engine) => engine.observeAggregate(subset, agg)))
    );
    aggregates.set(key, atom);
    return atom;
  };

  const groupedAggregates = new Map<string, Atom.Atom<GroupedAggregateResult>>();
  const aggregateGrouped = (
    subset: Subset.Subset,
    agg: Aggregate.Aggregate,
    groupBy: string
  ): Atom.Atom<GroupedAggregateResult> => {
    const key = `${Subset.hash(subset)}:${Hash.canonicalJson(agg)}:${groupBy}`;
    const existing = groupedAggregates.get(key);
    if (existing !== undefined) return existing;
    const atom = runtime.atom(
      Stream.unwrap(
        Effect.map(ClientEngine, (engine) => engine.observeAggregateGrouped(subset, agg, groupBy))
      )
    );
    groupedAggregates.set(key, atom);
    return atom;
  };

  const mutation = runtime.fn((arg: MutationArg) =>
    Effect.flatMap(ClientEngine, (engine) => engine.mutate(arg.mutator, arg.args))
  );

  const mutationWithAck = runtime.fn((arg: MutationArg) =>
    Effect.flatMap(ClientEngine, (engine) =>
      engine
        .mutateWithAck(arg.mutator, arg.args)
        .pipe(Effect.flatMap((handle) => handle.acknowledged))
    )
  );

  // A single shared atom for the whole map; `mutationsFor` derives from it
  // (Atom.mapResult) rather than opening a second engine subscription.
  const mutationStates: Atom.Atom<MutationStatesResult> = runtime.atom(
    Stream.unwrap(Effect.map(ClientEngine, (engine) => engine.mutationStates))
  );

  const mutationsForCache = new Map<string, Atom.Atom<MutationsForResult>>();
  const mutationsFor = (mutator: string): Atom.Atom<MutationsForResult> => {
    const existing = mutationsForCache.get(mutator);
    if (existing !== undefined) return existing;
    const atom = Atom.mapResult(mutationStates, (states) =>
      [...HashMap.values(states)]
        .filter((state) => state.mutator === mutator)
        .toSorted((a, b) => a.mutationId - b.mutationId)
    );
    mutationsForCache.set(mutator, atom);
    return atom;
  };

  return {
    runtime,
    liveQuery: liveQuery as EngineAtoms["liveQuery"],
    namedQuery,
    aggregate,
    aggregateGrouped,
    mutation,
    mutationWithAck,
    mutationStates,
    mutationsFor,
  };
};
