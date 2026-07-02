/**
 * EngineAtoms
 *
 * The engine's `effect/unstable/reactivity` Atom surface (ADR-0007): live
 * query and named-query atoms whose value re-emits on every local change,
 * plus a mutation atom for optimistic writes. Built over an `Atom.runtime`
 * from the engine layer, so the registry owns the engine's scope.
 *
 * Atoms are the UI surface. Framework packages (e.g. @legation/react) are
 * thin bindings over these — they mount an atom against an `AtomRegistry`,
 * they do not re-implement reactivity.
 *
 * For binding against a *resolved* observe-source instance (a `ClientEngine`
 * value, or a browser `TabMirror`) rather than the engine layer, see
 * `LiveQuery`, which wraps `source.observe(subset)` with the registry's
 * default runtime.
 */

import type { Cause, Layer } from "effect";
import { Effect, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { AsyncResult, AtomRegistry, Reactivity } from "effect/unstable/reactivity";
import { ClientEngine, type LocalRow } from "./ClientEngine.js";
import type { MutatorError, QueryError, StoreError } from "./Errors.js";
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

/** A named query's Atom value (adds `QueryError` to the failure channel). */
export type NamedQueryResult = AsyncResult.AsyncResult<
  Rows,
  StoreError | MutatorError | QueryError | Cause.NoSuchElementError
>;

/** What to write to the mutation atom to run a mutator optimistically. */
export interface MutationArg {
  readonly mutator: string;
  readonly args: unknown;
}

/** The engine's reactive surface, built from its layer. */
export interface EngineAtoms {
  /** The runtime backing every engine atom; the registry owns its scope. */
  readonly runtime: Atom.AtomRuntime<ClientEngine, never>;
  /**
   * The Atom for a subset's live results. Stable per subset identity
   * (`Subset.hash`): the same subset yields the same Atom, so mounting it
   * from many components shares one subscription.
   */
  readonly liveQuery: (subset: Subset.Subset) => Atom.Atom<LiveQueryResult>;
  /** The Atom for a named query's live results, stable per (name, args). */
  readonly namedQuery: (name: string, args: unknown) => Atom.Atom<NamedQueryResult>;
  /** Write a {@link MutationArg} to run a mutator; its result is an `AsyncResult`. */
  readonly mutation: Atom.AtomResultFn<MutationArg, void, MutatorError | StoreError>;
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
    const key = `${name}:${JSON.stringify(args)}`;
    const existing = namedQueries.get(key);
    if (existing !== undefined) return existing;
    const atom = runtime.atom(
      Stream.unwrap(Effect.map(ClientEngine, (engine) => engine.observeNamed(name, args)))
    );
    namedQueries.set(key, atom);
    return atom;
  };

  const mutation = runtime.fn((arg: MutationArg) =>
    Effect.flatMap(ClientEngine, (engine) => engine.mutate(arg.mutator, arg.args))
  );

  return { runtime, liveQuery, namedQuery, mutation };
};
