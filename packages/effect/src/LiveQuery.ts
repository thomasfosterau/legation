/**
 * LiveQuery
 *
 * Read-side integration with `effect/reactivity` (ADR-0007): turn
 * a live query — a subset observed against the local view — into an Atom
 * whose value re-emits on every local change (patch applied, overlay
 * changed). Atoms are the UI surface; the engine's own change stream is the
 * reactive source, so this is just a binding, not a second cache.
 *
 * The binding is host-agnostic: anything exposing `observe(subset) ->
 * Stream<rows>` qualifies — the in-process `ClientEngine` and the browser
 * `Mirror` both do — so the same `LiveQuery.make(source).atom(subset)`
 * works on the main thread, in a worker, or against a mirror.
 */

import type { Cause, Stream } from "effect";
import { Atom, type AsyncResult } from "effect/reactivity";
import type { LocalRow } from "./ClientEngine.js";
import * as Subset from "./Subset.js";

/** Anything that observes a subset as a stream of materialized rows. */
export interface LiveQuerySource<E> {
  readonly observe: (subset: Subset.Subset) => Stream.Stream<ReadonlyArray<LocalRow>, E>;
}

/**
 * The Atom value for a live query: `AsyncResult` of the current rows. A
 * never-ending source means it stays `Success` (or `Failure`) after the
 * first emission; `NoSuchElementError` only appears if a source completes
 * without emitting.
 */
export type LiveQueryResult<E> = AsyncResult.AsyncResult<
  ReadonlyArray<LocalRow>,
  E | Cause.NoSuchElementError
>;

export interface LiveQueries<E> {
  /**
   * The Atom for a subset's live results. Stable per subset identity
   * (`Subset.hash`): the same subset yields the same Atom, so mounting it
   * from many components shares one subscription.
   */
  readonly atom: (subset: Subset.Subset) => Atom.Atom<LiveQueryResult<E>>;
}

/** Build the Atom factory for a source's live queries. */
export const make = <E>(source: LiveQuerySource<E>): LiveQueries<E> => {
  const cache = new Map<string, Atom.Atom<LiveQueryResult<E>>>();
  return {
    atom: (subset) => {
      const key = Subset.hash(subset);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const created = Atom.make(source.observe(subset));
      cache.set(key, created);
      return created;
    },
  };
};
