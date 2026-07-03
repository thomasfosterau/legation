/**
 * Rune-based live queries (Svelte 5)
 *
 * The `use*` hooks bridge live queries to Svelte 5 runes: each returns an
 * object whose reactive `current` is an `AsyncResult` (the same result
 * vocabulary as the engine's reactivity atoms and the React binding). Inputs
 * are thunks called inside `$effect`, so a hook re-subscribes whenever the
 * reactive state its thunk reads changes — a paginated subset whose cursor
 * lives in `$state` just works — while the previous value is kept visible as
 * a waiting result (stale-while-revalidate).
 *
 * Import from `@legation/svelte/runes` (requires Svelte 5; the classic
 * `Readable` stores on the package root remain for Svelte 4). Like the
 * stores, hooks must be called during component initialisation — they read
 * the engine runtime from context ({@link setEngineRuntime}) and register a
 * `$effect`.
 */
import { untrack } from "svelte";
import { Cause, Effect, Fiber, Option, Stream } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  Aggregate,
  ClientEngine,
  ClientView,
  type Collection,
  type MutatorError,
  type QueryError,
  Related,
  type StoreError,
  type Subset,
  type TransportError,
} from "@legation/effect";
import { getEngineRuntime, withEngine, type EffectSyncRuntime } from "./runtime.js";
import { getMutate, getMutateWithAck } from "./mutation.js";
import type { Rows } from "./query.js";

/** A live result: `current` re-renders whatever reads it on every emission. */
export interface Live<A, E = never> {
  /**
   * The current result. `Initial` until the first emission, then `Success`
   * per emission; while re-subscribing after an input change the previous
   * result is kept with `waiting: true` (stale-while-revalidate).
   */
  readonly current: AsyncResult.AsyncResult<A, E>;
}

/** Options shared by the live hooks. */
export interface LiveOptions<A> {
  /**
   * Seed `current` with a synchronous `Success` before the first emission —
   * during SSR (where `$effect` never runs) this is what renders, and on the
   * client it makes the first render match the server markup (no loading
   * flash). Compute it from the page's hydration snapshot, e.g. with
   * `Hydration.rowsFor(snapshot, subset)`.
   */
  readonly initial?: A;
}

/** The error channel of view reads (engine or mirror). */
export type LiveError = StoreError | MutatorError | TransportError;

/**
 * Core plumbing: re-run `makeProgram` inside `$effect` (tracking the reactive
 * state it reads), forking the produced stream on the context runtime and
 * interrupting it on re-run/unmount. Emissions land in a raw `$state` — the
 * results are engine snapshots, not something to deep-proxy.
 */
const live = <A, E>(
  runtime: EffectSyncRuntime,
  makeStream: () => (view: ClientView.ClientView) => Stream.Stream<A, E>,
  options?: LiveOptions<A>
): Live<A, E> => {
  let current = $state.raw<AsyncResult.AsyncResult<A, E>>(
    options?.initial !== undefined
      ? AsyncResult.success(options.initial, { waiting: true })
      : AsyncResult.initial(true)
  );
  $effect(() => {
    const toStream = makeStream();
    current = AsyncResult.waitingFrom(Option.some(untrack(() => current)));
    const fiber = runtime.runFork(
      Effect.flatMap(ClientView.ClientView, (view) =>
        Stream.runForEach(toStream(view), (value) =>
          Effect.sync(() => {
            current = AsyncResult.success(value);
          })
        )
      ).pipe(
        Effect.catchCause((cause) =>
          // Interruption is the hook's own teardown, not a failure.
          Cause.hasFails(cause) || Cause.hasDies(cause)
            ? Effect.sync(() => {
                current = AsyncResult.failure(cause as Cause.Cause<E>);
              })
            : Effect.void
        )
      )
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  });
  return {
    get current() {
      return current;
    },
  };
};

/**
 * Live result of a subset, re-subscribing when the thunk's reactive inputs
 * change. A {@link Subset.TypedSubset} refines the rows to its row type.
 */
export function useQuery<A>(
  subset: () => Subset.TypedSubset<A>,
  options?: LiveOptions<ReadonlyArray<ClientEngine.TypedRow<A>>>
): Live<ReadonlyArray<ClientEngine.TypedRow<A>>, LiveError>;
export function useQuery(
  subset: () => Subset.Subset,
  options?: LiveOptions<Rows>
): Live<Rows, LiveError>;
export function useQuery(
  subset: () => Subset.Subset,
  options?: LiveOptions<Rows>
): Live<Rows, LiveError> {
  return live(
    getEngineRuntime(),
    () => {
      const value = subset();
      return (view) => view.observe(value);
    },
    options
  );
}

/** Live result of a named query (Query.ts), with reactive name/args. */
export const useNamedQuery = (
  query: () => { readonly name: string; readonly args: unknown },
  options?: LiveOptions<Rows>
): Live<Rows, LiveError | QueryError> =>
  live(
    getEngineRuntime(),
    () => {
      const { name, args } = query();
      return withEngine("useNamedQuery", (engine) => engine.observeNamed(name, args));
    },
    options
  );

/**
 * Live aggregate over a subset (count/sum/min/max/avg). Local tier only —
 * the aggregate sees the rows this client has synced.
 */
export const useAggregate = (
  subset: () => Subset.Subset,
  aggregate: Aggregate.Aggregate,
  options?: LiveOptions<Aggregate.AggregateValue>
): Live<Aggregate.AggregateValue, LiveError> =>
  live(
    getEngineRuntime(),
    () => {
      const value = subset();
      return (view) => Aggregate.observe(view.observe(value), aggregate);
    },
    options
  );

/** Live grouped aggregate over a subset, keyed by `String(row.value[groupBy])`. */
export const useAggregateGrouped = (
  subset: () => Subset.Subset,
  aggregate: Aggregate.Aggregate,
  groupBy: string,
  options?: LiveOptions<Record<string, Aggregate.AggregateValue>>
): Live<Record<string, Aggregate.AggregateValue>, LiveError> =>
  live(
    getEngineRuntime(),
    () => {
      const value = subset();
      return (view) => Aggregate.observeGrouped(view.observe(value), aggregate, groupBy);
    },
    options
  );

/** Reactive inputs of {@link useRelated}. */
export interface RelatedInputs {
  readonly registry: Collection.CollectionRegistry;
  readonly collection: string;
  readonly subset: Subset.Subset;
  readonly names: ReadonlyArray<string>;
}

/**
 * Live join over a subset's declared relationships. By default it reads the
 * mirror ({@link Related.observe} — the base and foreign collections must
 * already be subscribed); with `subscribe: true` it syncs the base and the
 * narrowed foreign subsets itself and tears the subscriptions down on
 * unmount ({@link Related.related}).
 */
export const useRelated = (
  inputs: () => RelatedInputs,
  options?: LiveOptions<ReadonlyArray<Related.RelatedRow>> & { readonly subscribe?: boolean }
): Live<ReadonlyArray<Related.RelatedRow>> =>
  live(
    getEngineRuntime(),
    () => {
      const { registry, collection, subset, names } = inputs();
      return options?.subscribe === true
        ? // Auto-subscription needs the full engine (subscribe + pull);
          // `Stream.unwrap` scopes the subscriptions to the stream's
          // lifetime: interrupting the hook's fiber unsubscribes them.
          withEngine("useRelated({ subscribe: true })", (engine) =>
            Stream.unwrap(Related.related(engine, registry, collection, subset, names))
          )
        : (view) => Related.observe(view, registry, collection, subset, names);
    },
    options
  );

/**
 * A `mutate(mutator, args)` bound to the context runtime, resolving on
 * journal (rune-module alias of `getMutate`).
 */
export const useMutation = getMutate;

/**
 * Like {@link useMutation}, but resolving with the mutation's authoritative
 * outcome once the backend settles it (rune-module alias of
 * `getMutateWithAck`).
 */
export const useMutationWithAck = getMutateWithAck;
