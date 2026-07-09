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
import { Effect, HashMap, Stream } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { Aggregate, Client, Query } from "@legation/effect";
import { ClientEngine, type MutationState } from "@legation/effect/internal";
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
const EMPTY_ROWS: ResolvedRows = [];

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

/** A live, growing connection over a read's root window (ADR-0024). */
export interface Connection extends Live<ResolvedRows> {
  /**
   * Widen the window by one page. A no-op while a widen is still resolving
   * or once {@link hasMore} is false — call it freely from a click handler.
   */
  readonly loadMore: () => void;
  /**
   * Whether another page may exist: `true` while the current window is
   * saturated (it holds as many rows as it asked for). Reactive. At a dataset
   * whose size is an exact multiple of the page size this stays `true` for one
   * more `loadMore`, which then resolves empty and flips it `false` — the
   * standard cost of limit-based paging without a separate total count.
   */
  readonly hasMore: boolean;
  /** Whether a page (the first or a widen) is currently resolving. Reactive. */
  readonly loading: boolean;
  /** Collapse back to the first page. */
  readonly reset: () => void;
}

/** Options for {@link useConnection}. */
export interface ConnectionOptions extends LiveOptions<ResolvedRows> {
  /** Rows per page — the window grows by this on each `loadMore`. Default 20. */
  readonly pageSize?: number;
}

/** The base read minus its window — the hook owns `first`/`after`. */
const connectionKey = (read: Query.Read): string => {
  const { first: _first, after: _after, ...base } = read;
  return JSON.stringify(base);
};

/**
 * Connection-style paging over a read's root window: a live result that
 * *grows* rather than jumping between detached pages. `loadMore` widens the
 * one window by a page (ADR-0024 — "load more widens the subset"), so each
 * page's rows accumulate and the previous ones stay on screen through the
 * widen (stale-while-revalidate); the engine only ever syncs the current
 * window, never the whole collection.
 *
 * Per-parent paging falls out of instantiating the hook per parent: scope
 * the read's `where` to a parent id and give each parent its own
 * `useConnection` (one per `{#each parents}` row), and each parent's list
 * pages independently, with its own `hasMore` and window. The read thunk
 * stays reactive — when its base (collection/where/order/include) changes the
 * connection re-bases to the first page automatically; the window it owns
 * (`first`/`after`) is ignored on the passed read.
 *
 * ```svelte
 * const reviews = useConnection(() => productReviews(id), { pageSize: 10 });
 * // {#each await reviews.promise as row (row.value.id)} … {/each}
 * // <button onclick={reviews.loadMore} disabled={!reviews.hasMore}>More</button>
 * ```
 */
export const useConnection = (read: () => Query.Read, options?: ConnectionOptions): Connection => {
  const pageSize = options?.pageSize ?? 20;
  let pages = $state(1);
  // Non-reactive: tracks the base read so a reused hook re-bases to page 1
  // when its inputs change (a per-parent instance never trips this).
  let baseKey: string | undefined;

  $effect(() => {
    const key = connectionKey(read());
    if (key !== baseKey) {
      baseKey = key;
      pages = 1;
    }
  });

  const windowed = live(
    getClientRuntime(),
    () => {
      const { first: _first, after: _after, ...base } = read();
      const first = pages * pageSize;
      return (client) => client.observe({ ...base, first });
    },
    options
  );

  const rows = (): ResolvedRows => AsyncResult.getOrElse(windowed.current, () => EMPTY_ROWS);

  return {
    get current() {
      return windowed.current;
    },
    get promise() {
      return windowed.promise;
    },
    get hasMore() {
      return rows().length >= pages * pageSize;
    },
    get loading() {
      return AsyncResult.isWaiting(windowed.current);
    },
    loadMore: () => {
      if (!AsyncResult.isWaiting(windowed.current) && rows().length >= pages * pageSize) {
        pages += 1;
      }
    },
    reset: () => {
      pages = 1;
    },
  };
};

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

/**
 * Reactive mutation-state list (#116) — TanStack Query's `useMutationState`
 * analogue: every journaled mutation's current lifecycle state (`pending` →
 * `acknowledged` | `rejected`), oldest-journaled first. Pass a `mutator`
 * thunk to scope to one mutator (reactive, like {@link useQuery}'s `read`);
 * omit it (or return `undefined`) for every mutation. Works identically over
 * an owned engine and a connected host (ADR-0021) — the same states either
 * way.
 */
export const useMutationState = (
  mutator?: () => string | undefined
): Live<ReadonlyArray<MutationState.MutationState>> =>
  live(
    getClientRuntime(),
    () => {
      const scope = mutator?.();
      return (client) =>
        client.mutationStates.pipe(
          Stream.map((states) =>
            [...HashMap.values(states)]
              .filter((state) => scope === undefined || state.mutator === scope)
              .toSorted((a, b) => a.mutationId - b.mutationId)
          )
        );
    },
    { initial: [] }
  );
