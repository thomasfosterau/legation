/**
 * Rune-based live queries (Svelte 5)
 *
 * The `use*` hooks speak **Query over the Client** (ADR-0022): reads are
 * declarative `Query.Read`s — collection, `where`, `include`d edges with
 * per-edge windows, `order`, cursor pagination — and where a read is
 * answered (replica, worker-hosted engine, server fallthrough) is the
 * Client's business, never the component's. Each hook returns an object
 * whose reactive `current` is an `AsyncResult` (the same result vocabulary
 * as the engine's reactivity atoms and the React binding), plus an
 * awaitable `promise` for Async Svelte. Inputs are thunks called inside
 * `$effect`, so a hook re-subscribes whenever the reactive state its thunk
 * reads changes — a read whose cursor lives in `$state` just works — while
 * the previous value stays visible as a waiting result
 * (stale-while-revalidate).
 *
 * Joins need no separate hook: `include` resolves edges onto each row
 * (`row.related`), windowed per the edge's declared order (ADR-0024), over
 * owned and worker-hosted engines alike.
 *
 * Import from `@legation/svelte/Runes` (requires Svelte 5; the classic
 * `Readable` stores on the package root remain for Svelte 4). Hooks must
 * be called during component initialisation — they read the Client runtime
 * from context ({@link setClientRuntime}) and register a `$effect`.
 */
import { useLiveStream } from "@thomasfosterau/effect-svelte";
import { Effect, Stream } from "effect";
import type { AsyncResult } from "effect/unstable/reactivity";
import { Aggregate, Client, Query } from "@legation/effect";
import { ClientEngine } from "@legation/effect/internal";
import { getClientRuntime, type ClientRuntime } from "./Runtime.js";

/** A live result: `current` re-renders whatever reads it on every emission. */
export interface Live<A, E = never> {
  /**
   * The current result. `Initial` until the first emission, then `Success`
   * per emission; while re-subscribing after an input change the previous
   * result is kept with `waiting: true` (stale-while-revalidate). An
   * `initial` seed starts as a non-waiting `Success` — "we have data", no
   * spinner over server-rendered content — until the first real emission.
   */
  readonly current: AsyncResult.AsyncResult<A, E>;
  /**
   * The awaitable view of the same result, for Async Svelte
   * (`experimental.async`): pending until the first data arrives — so
   * `await rows.promise` in a derived or template suspends the enclosing
   * `<svelte:boundary>`'s `pending` snippet — then an already-resolved
   * promise replaced on every emission (and on input change), so awaiting
   * expressions re-run with fresh rows while Svelte keeps the previous UI
   * on screen (stale-while-revalidate). A failed stream rejects it, which
   * the boundary's `failed` snippet catches.
   */
  readonly promise: Promise<A>;
}

/** Options shared by the live hooks. */
export interface LiveOptions<A> {
  /**
   * Seed `current` with a synchronous `Success` before the first emission —
   * during SSR (where `$effect` never runs) this is what renders, and on the
   * client it makes the first render match the server markup (no loading
   * flash). Compute it from the rows the page's load already fetched.
   */
  readonly initial?: A;
}

/** The rows a read resolves to: node values with their included edges. */
export type ResolvedRows = ReadonlyArray<Client.ResolvedRow>;

/**
 * Core plumbing — effect-svelte's `useLiveStream` does the work (thunk
 * tracked inside `$effect`, interrupt-and-resubscribe on input change with
 * the previous value kept as a waiting result, emissions in `$state.raw`,
 * teardown interruption never surfacing as a failure, `initial` seeding a
 * synchronous `Success`). This adapter resolves the Client from the
 * context runtime and keeps the SSR seam below.
 */
const live = <A, E>(
  runtime: ClientRuntime,
  makeStream: () => (client: Client.Client) => Stream.Stream<A, E>,
  options?: LiveOptions<A>
): Live<A, E> => {
  const result = useLiveStream(
    () => {
      const toStream = makeStream();
      return Stream.unwrap(Effect.map(Client.Client, (client) => toStream(client)));
    },
    { runtime, ...(options?.initial === undefined ? {} : { initial: options.initial }) }
  );
  return {
    get current() {
      return result.current;
    },
    get promise() {
      // During SSR (no `$effect`, so no live stream) a seeded hook exposes
      // its value DIRECTLY: Svelte's server renderer defers real promises to
      // the boundary's `pending` snippet but renders awaited plain values
      // synchronously — so seeded pages fully server-render, and unseeded
      // ones legitimately show `pending`.
      if (typeof document === "undefined" && options?.initial !== undefined) {
        return options.initial as unknown as Promise<A>;
      }
      return result.promise;
    },
  };
};

/**
 * Live result of a declarative read, re-subscribing when the thunk's
 * reactive inputs change. `include`d edges resolve onto each row's
 * `related`, windowed per the edge's declared order (ADR-0024). Observing
 * IS subscribing: the read's windows are registered for the hook's
 * lifetime through the Client's ledger.
 */
export const useQuery = (
  read: () => Query.Read,
  options?: LiveOptions<ResolvedRows>
): Live<ResolvedRows> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      return (client) => client.observe(value);
    },
    options
  );

/** Live result of a named query (server-resolved), with reactive name/args. */
export const useNamedQuery = (
  query: () => { readonly name: string; readonly args: unknown },
  options?: LiveOptions<ReadonlyArray<ClientEngine.LocalRow>>
): Live<ReadonlyArray<ClientEngine.LocalRow>> =>
  live(
    getClientRuntime(),
    () => {
      const { name, args } = query();
      return (client) => client.view.observeNamed(name, args).pipe(Stream.orDie);
    },
    options
  );

/**
 * Live aggregate over a read's root window (count/sum/min/max/avg). Local
 * tier only — the aggregate sees the rows this client has synced.
 */
export const useAggregate = (
  read: () => Query.Read,
  aggregate: Aggregate.Aggregate,
  options?: LiveOptions<Aggregate.AggregateValue>
): Live<Aggregate.AggregateValue> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      return (client) =>
        Aggregate.observe(
          client.view.observe(Query.plan(client.nodes, value).root).pipe(Stream.orDie),
          aggregate
        );
    },
    options
  );

/** Live grouped aggregate over a read's root window, keyed by `String(row.value[groupBy])`. */
export const useAggregateGrouped = (
  read: () => Query.Read,
  aggregate: Aggregate.Aggregate,
  groupBy: string,
  options?: LiveOptions<Record<string, Aggregate.AggregateValue>>
): Live<Record<string, Aggregate.AggregateValue>> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      return (client) =>
        Aggregate.observeGrouped(
          client.view.observe(Query.plan(client.nodes, value).root).pipe(Stream.orDie),
          aggregate,
          groupBy
        );
    },
    options
  );

/**
 * A `mutate(mutation, args)` bound to the context Client, resolving on
 * journal (the write is applied optimistically before the promise settles).
 */
export const useMutation = (): ((mutation: string, args: unknown) => Promise<void>) => {
  const runtime = getClientRuntime();
  return (mutation, args) =>
    runtime.runPromise(Effect.flatMap(Client.Client, (client) => client.mutate(mutation, args)));
};

/**
 * Like {@link useMutation}, but resolving with the mutation's authoritative
 * outcome once the backend settles it.
 */
export const useMutationWithAck = (): ((
  mutation: string,
  args: unknown
) => Promise<ClientEngine.MutationOutcome>) => {
  const runtime = getClientRuntime();
  return (mutation, args) =>
    runtime.runPromise(
      Effect.flatMap(Client.Client, (client) => client.mutateWithAck(mutation, args))
    );
};
