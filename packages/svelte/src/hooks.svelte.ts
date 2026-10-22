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
 * Re-exported from the package root (`@thomasfosterau/legation-svelte`), which is the only
 * read/write surface. Requires Svelte 5. Hooks must be called during
 * component initialisation — they read the Client runtime from context
 * ({@link setClientRuntime}) and register a `$effect`.
 */
import { useLiveStream } from "@thomasfosterau/effect-svelte";
import { Effect, Fiber, HashMap, Stream } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Aggregate, Client, Query } from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  type MutationState,
  type Undo,
} from "@thomasfosterau/legation-effect/internal";
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

/** A `promise` that never settles — `.promise` while a read thunk opts out. */
const NEVER_PROMISE: Promise<never> = new Promise(() => {});

/**
 * Core plumbing — effect-svelte's `useLiveStream` does the work (thunk
 * tracked inside `$effect`, interrupt-and-resubscribe on input change with
 * the previous value kept as a waiting result, emissions in `$state.raw`,
 * teardown interruption never surfacing as a failure, `initial` seeding a
 * synchronous `Success`). This adapter resolves the Client from the
 * context runtime and keeps the SSR seam below.
 *
 * `makeStream` returning `undefined` is the read thunk's opt-out (#141):
 * "nothing right now". No window is ever registered and no request is
 * issued, because the closure that would call `client.observe`/
 * `view.observeNamed` never runs — `Stream.never` stands in, so
 * `useLiveStream`'s own subscription does nothing. `optedOut` then forces
 * `current`/`promise` back to their pre-subscription state regardless of
 * what that never-emitting subscription leaves behind in `useLiveStream`'s
 * state (stale-while-revalidate would otherwise keep a prior success
 * visible, tagged "waiting", forever) — so an opted-out read stays
 * `Initial`, distinguishable from a `Success` over zero rows, whether the
 * thunk never ran or ran once and opted back out.
 */
const live = <A, E>(
  runtime: ClientRuntime,
  makeStream: () => ((client: Client.Client) => Stream.Stream<A, E>) | undefined,
  options?: LiveOptions<A>
): Live<A, E> => {
  let optedOut = $state(false);
  const result = useLiveStream(
    () => {
      const toStream = makeStream();
      if (toStream === undefined) {
        optedOut = true;
        return Stream.never;
      }
      optedOut = false;
      return Stream.unwrap(Effect.map(Client.Client, (client) => toStream(client)));
    },
    { runtime, ...(options?.initial === undefined ? {} : { initial: options.initial }) }
  );
  return {
    get current() {
      return optedOut ? AsyncResult.initial() : result.current;
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
      return optedOut ? NEVER_PROMISE : result.promise;
    },
  };
};

/**
 * Live result of a declarative read, re-subscribing when the thunk's
 * reactive inputs change. `include`d edges resolve onto each row's
 * `related`, windowed per the edge's declared order (ADR-0024). Observing
 * IS subscribing: the read's windows are registered for the hook's
 * lifetime through the Client's ledger.
 *
 * The thunk may return `undefined` to opt out (#141) — "nothing right now",
 * for a read keyed on a selection that starts empty. No window is
 * registered and no request is issued; `current` stays `Initial` rather
 * than becoming a `Success` over zero rows, so an opted-out read stays
 * distinguishable from one that legitimately matched nothing. The thunk
 * stays reactive either way: flipping the condition subscribes/unsubscribes
 * with the same stale-while-revalidate behaviour as any other input change.
 */
export const useQuery = (
  read: () => Query.Read | undefined,
  options?: LiveOptions<ResolvedRows>
): Live<ResolvedRows> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      if (value === undefined) return undefined;
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
 *
 * The read thunk may return `undefined` to opt out (#141): no window is
 * registered and no request issued, `current` stays `Initial`, and paging
 * state (`hasMore`/`loading`) reads as idle until the thunk starts returning
 * a read again.
 *
 * **Engine-level retargeting (#133).** When the read has no `include`d edges
 * and the view is engine-backed (`ClientView.observeWindow` present — a
 * `Mirror` has none, see `docs/observing-row-changes.md`), `loadMore`/`reset`
 * widen or shrink the SAME open observation's window via
 * `ClientEngine.observeWindow`'s `retarget` — reusing `LiveView`'s maintained
 * order instead of tearing the stream down and resubscribing wider each page.
 * The stream itself is still built once per *base* change (collection/where/
 * order/include), exactly as before; only `pages` no longer forces a rebuild.
 * A joined read, or a mirror-backed connection, falls back to the original
 * resubscribe-per-page behavior, unchanged.
 */
export const useConnection = (
  read: () => Query.Read | undefined,
  options?: ConnectionOptions
): Connection => {
  const pageSize = options?.pageSize ?? 20;
  const runtime = getClientRuntime();
  let pages = $state(1);
  // Non-reactive: tracks the base read so a reused hook re-bases to page 1
  // when its inputs change (a per-parent instance never trips this).
  // `undefined` also covers the opted-out state (#141).
  let baseKey: string | undefined;

  $effect(() => {
    const value = read();
    const key = value === undefined ? undefined : connectionKey(value);
    if (key !== baseKey) {
      baseKey = key;
      pages = 1;
    }
  });

  // The current base's retarget handle, set once per base change from inside
  // the stream thunk below. `loadMore`/`reset` widen/shrink through it
  // instead of relying on `pages` to force a resubscribe — `pages` is
  // deliberately read only inside the thunk's *async* body below, which
  // Svelte's effect tracking never sees, so changing it alone no longer
  // retriggers `useLiveStream`'s interrupt-and-resubscribe. `undefined` when
  // the current base has no engine-level retarget available (falls back to
  // the pre-#133 behavior).
  let retargetHandle:
    | { readonly baseKey: string; readonly retarget: (limit: number) => void }
    | undefined;

  const windowed = live(
    runtime,
    () => {
      const value = read();
      if (value === undefined) {
        retargetHandle = undefined;
        return undefined;
      }
      const { first: _first, after: _after, ...base } = value;
      const key = connectionKey(value);
      return (client) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const observeWindow = client.view.observeWindow;
            const hasEdges = Object.keys(base.include ?? {}).length > 0;
            if (hasEdges || observeWindow === undefined) {
              retargetHandle = undefined;
              return client.observe({ ...base, first: pages * pageSize });
            }
            const compiled = Query.plan(client.nodes, { ...base, first: pageSize });
            const opened = yield* observeWindow(compiled.root);
            retargetHandle = {
              baseKey: key,
              retarget: (limit) => {
                runtime.runFork(opened.retarget({ limit }));
              },
            };
            // Defensive: `pages` is always freshly reset to 1 by the base-key
            // effect above before this thunk re-runs, but this keeps the
            // observation correct even if that ordering ever changes.
            if (pages > 1) retargetHandle.retarget(pages * pageSize);
            return opened.rows.pipe(
              Stream.orDie,
              Stream.map((rows) => rows.map((row) => ({ ...row, related: {} })))
            );
          }).pipe(Effect.orDie)
        );
    },
    options
  );

  const rows = (): ResolvedRows => AsyncResult.getOrElse(windowed.current, () => EMPTY_ROWS);

  const widenTo = (nextPages: number) => {
    pages = nextPages;
    const handle = retargetHandle;
    if (handle !== undefined && handle.baseKey === baseKey) handle.retarget(pages * pageSize);
  };

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
        widenTo(pages + 1);
      }
    },
    reset: () => widenTo(1),
  };
};

/**
 * Live result of a named query (server-resolved), with reactive name/args.
 * The thunk may return `undefined` to opt out (#141): see {@link useQuery}.
 */
export const useNamedQuery = (
  query: () => { readonly name: string; readonly args: unknown } | undefined,
  options?: LiveOptions<ReadonlyArray<ClientEngine.LocalRow>>
): Live<ReadonlyArray<ClientEngine.LocalRow>> =>
  live(
    getClientRuntime(),
    () => {
      const value = query();
      if (value === undefined) return undefined;
      const { name, args } = value;
      return (client) => client.view.observeNamed(name, args).pipe(Stream.orDie);
    },
    options
  );

/**
 * Live aggregate over a read's root window (count/sum/min/max/avg). Local
 * tier only — the aggregate sees the rows this client has synced. The read
 * thunk may return `undefined` to opt out (#141): see {@link useQuery}.
 */
export const useAggregate = (
  read: () => Query.Read | undefined,
  aggregate: Aggregate.Aggregate,
  options?: LiveOptions<Aggregate.AggregateValue>
): Live<Aggregate.AggregateValue> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      if (value === undefined) return undefined;
      return (client) =>
        Aggregate.observe(
          client.view.observe(Query.plan(client.nodes, value).root).pipe(Stream.orDie),
          aggregate
        );
    },
    options
  );

/**
 * Live grouped aggregate over a read's root window, keyed by
 * `String(row.value[groupBy])`. The read thunk may return `undefined` to
 * opt out (#141): see {@link useQuery}.
 */
export const useAggregateGrouped = (
  read: () => Query.Read | undefined,
  aggregate: Aggregate.Aggregate,
  groupBy: string,
  options?: LiveOptions<Record<string, Aggregate.AggregateValue>>
): Live<Record<string, Aggregate.AggregateValue>> =>
  live(
    getClientRuntime(),
    () => {
      const value = read();
      if (value === undefined) return undefined;
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

/** Live undo/redo availability plus the two commands. */
export interface UndoControls {
  /** Whether an undo is currently possible. Reactive. */
  readonly canUndo: boolean;
  /** Whether a redo is currently possible. Reactive. */
  readonly canRedo: boolean;
  /** Run the manager's `undo` (a no-op when nothing is undoable). */
  readonly undo: () => Promise<void>;
  /** Run the manager's `redo` (a no-op when nothing is redoable). */
  readonly redo: () => Promise<void>;
}

/** Drain a boolean stream into `$state`, interrupting on teardown. */
const useFlag = (changes: Stream.Stream<boolean>): { readonly current: boolean } => {
  let value = $state(false);
  $effect(() => {
    // The manager's streams close over the engine (no `R`), so they run on the
    // default runtime — `useUndo` needs no Client in context.
    const fiber = Effect.runFork(
      Stream.runForEach(changes, (next) => Effect.sync(() => (value = next)))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });
  return {
    get current() {
      return value;
    },
  };
};

/**
 * Undo/redo over a manager's history as runes. Build one manager per client
 * with `Undo.make(handle)` — a `Client` or a `ClientEngine` both work
 * (issue #223) — and call this during component initialisation.
 */
export const useUndo = <E>(manager: Undo.UndoManager<E>): UndoControls => {
  const canUndo = useFlag(manager.canUndoChanges);
  const canRedo = useFlag(manager.canRedoChanges);
  return {
    get canUndo() {
      return canUndo.current;
    },
    get canRedo() {
      return canRedo.current;
    },
    undo: () => Effect.runPromise(Effect.ignore(manager.undo)),
    redo: () => Effect.runPromise(Effect.ignore(manager.redo)),
  };
};
