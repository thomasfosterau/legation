/**
 * Live query stores
 *
 * `query` / `namedQuery` bridge a live query (an Effect `Stream` over the
 * mirror) to a Svelte `Readable` store: the store's `start` callback forks the
 * view's `observe` in a fiber and pushes each snapshot through `set`; the
 * returned `stop` callback interrupts that fiber when the last subscriber
 * unsubscribes. Read them with Svelte's `$store` auto-subscription, so the
 * component re-renders on every local change (mutation, push ack, pull/rebase).
 *
 * The stores run over the runtime's {@link ClientView} — a main-thread engine
 * or a mirror equally (ADR-0021), including `namedQuery` and `related`
 * (a mirror forwards the registration to its host over the protocol).
 */
import { readable, type Readable } from "svelte/store";
import { Effect, Fiber, Stream } from "effect";
import {
  Aggregate,
  ClientEngine,
  ClientView,
  type Collection,
  Related,
  type Subset,
} from "@legation/effect";
import { getEngineRuntime, type EffectSyncRuntime } from "./Runtime.js";

/** A live query snapshot: the materialised rows (confirmed + overlay). */
export type Rows = ReadonlyArray<ClientEngine.LocalRow>;
const EMPTY: Rows = [];

const makeStore = <T>(
  runtime: EffectSyncRuntime,
  initial: T,
  toStream: (view: ClientView.ClientView) => Stream.Stream<T, unknown>
): Readable<T> =>
  readable<T>(initial, (set) => {
    const run = Effect.flatMap(ClientView.ClientView, (view) =>
      Stream.runForEach(toStream(view), (value) => Effect.sync(() => set(value)))
    ).pipe(Effect.catchCause(() => Effect.void));
    const fiber = runtime.runFork(run);
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  });

/**
 * Live result of a subset, re-emitting on every local change. A
 * {@link Subset.TypedSubset} refines the rows to its row type; a plain
 * `Subset` returns untyped rows.
 */
export function query<A>(
  subset: Subset.TypedSubset<A>
): Readable<ReadonlyArray<ClientEngine.TypedRow<A>>>;
export function query(subset: Subset.Subset): Readable<Rows>;
export function query(subset: Subset.Subset): Readable<Rows> {
  return makeStore(getEngineRuntime(), EMPTY, (view) => view.observe(subset));
}

/** Live result of a named query (Query.ts), over either view host. */
export const namedQuery = (name: string, args: unknown): Readable<Rows> =>
  makeStore(getEngineRuntime(), EMPTY, (view) => view.observeNamed(name, args));

/**
 * Live aggregate over a subset (count/sum/min/max/avg), re-emitting only when
 * the value changes. Starts `undefined` until the first emission. Local tier
 * only — the aggregate sees the rows this client has synced.
 */
export const aggregate = (
  subset: Subset.Subset,
  agg: Aggregate.Aggregate
): Readable<Aggregate.AggregateValue> =>
  makeStore<Aggregate.AggregateValue>(getEngineRuntime(), undefined, (view) =>
    Aggregate.observe(view.observe(subset), agg)
  );

/** Live grouped aggregate over a subset, keyed by `String(row.value[groupBy])`. */
export const aggregateGrouped = (
  subset: Subset.Subset,
  agg: Aggregate.Aggregate,
  groupBy: string
): Readable<Record<string, Aggregate.AggregateValue>> =>
  makeStore<Record<string, Aggregate.AggregateValue>>(getEngineRuntime(), {}, (view) =>
    Aggregate.observeGrouped(view.observe(subset), agg, groupBy)
  );

/**
 * Live join over a subset's declared relationships ({@link Related.observe}
 * as a store): each emission carries the base rows with their related rows
 * resolved by name, re-emitting when the base or a referenced foreign row
 * changes. The base and foreign collections must already be subscribed — this
 * reads the mirror, it does not subscribe.
 */
export const related = (
  registry: Collection.CollectionRegistry,
  collectionName: string,
  subset: Subset.Subset,
  names: ReadonlyArray<string>
): Readable<ReadonlyArray<Related.RelatedRow>> =>
  makeStore<ReadonlyArray<Related.RelatedRow>>(getEngineRuntime(), [], (view) =>
    Related.observe(view, registry, collectionName, subset, names)
  );
