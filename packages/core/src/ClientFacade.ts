/**
 * Facade
 *
 * A promise/callback API over the Effect-native `QueryClient`, for
 * non-Effect consumers (vanilla JS apps, React hooks, service-worker
 * scripts). Loaders and mutators are plain `() => Promise<A>` functions,
 * converted to effects internally; subscriptions are delivered to
 * callbacks.
 *
 * Built on core's `PromiseFacade`, wrapping a `QueryClient` layer over an
 * in-memory cache store.
 */

import { Effect, Layer, Option, Stream } from "effect";
import * as MemoryCacheStore from "./MemoryCacheStore.js";
import * as PromiseFacade from "./PromiseFacade.js";
import * as Query from "./Query.js";
import * as SyncKey from "./SyncKey.js";
import * as QueryClientModule from "./QueryClient.js";

const QueryClient = QueryClientModule.QueryClient;
type QueryClient = QueryClientModule.QueryClient;

/**
 * Options controlling a promise-facade client.
 */
export interface ClientOptions {
  /** Maximum number of cache entries kept (least-recently-written eviction). */
  readonly maxEntries?: number | undefined;
}

/**
 * Per-fetch options exposed to promise callers.
 */
export interface FetchOptions {
  /** How long the loaded value stays fresh, in milliseconds. */
  readonly staleTimeMillis?: number | undefined;
  /** How long the loaded value may live before eviction, in milliseconds. */
  readonly timeToLiveMillis?: number | undefined;
  /** Tags for group invalidation. */
  readonly tags?: ReadonlyArray<string> | undefined;
  /** Force a fresh load, bypassing any cached value. */
  readonly forceRefresh?: boolean | undefined;
}

/**
 * Callbacks for an observed query subscription.
 */
export interface SubscribeCallbacks<A> {
  /** Called with each new query state. */
  readonly onState: (state: Query.QueryState<A, unknown>) => void;
  /** Called when the subscription stream ends. */
  readonly onDone?: (() => void) | undefined;
}

/**
 * A handle returned by {@link PromiseClient.subscribe}.
 */
export type Unsubscribe = () => void;

/**
 * The promise/callback client surface.
 */
export interface PromiseClient {
  /** Fetch a key through the cache, loading via `loader` on a miss. */
  readonly fetch: <A>(
    key: SyncKey.SyncKey,
    loader: () => Promise<A>,
    options?: FetchOptions
  ) => Promise<A>;
  /** Run a mutation that pushes via `mutator`, returning its result. */
  readonly mutate: <Input, A>(
    key: SyncKey.SyncKey,
    mutator: (input: Input) => Promise<A>,
    input: Input,
    options?: {
      readonly invalidates?: ReadonlyArray<SyncKey.SyncKey> | undefined;
      readonly invalidatesTags?: ReadonlyArray<string> | undefined;
    }
  ) => Promise<A>;
  /** Read the currently-cached value for a key, if any. */
  readonly getQueryData: <A>(key: SyncKey.SyncKey) => Promise<A | undefined>;
  /** Write a value directly into the cache under a key. */
  readonly setQueryData: <A>(key: SyncKey.SyncKey, value: A) => Promise<void>;
  /** Mark every entry under `keyPrefix` stale. */
  readonly invalidate: (keyPrefix: SyncKey.SyncKey) => Promise<void>;
  /**
   * Observe a query: load via `loader`, then deliver state updates to
   * `callbacks` as the cache entry changes. Returns an unsubscribe handle.
   */
  readonly subscribe: <A>(
    key: SyncKey.SyncKey,
    loader: () => Promise<A>,
    callbacks: SubscribeCallbacks<A>,
    options?: FetchOptions
  ) => Unsubscribe;
  /** Tear down the runtime and every running subscription. */
  readonly dispose: () => Promise<void>;
}

const buildDescriptor = <A>(
  key: SyncKey.SyncKey,
  loader: () => Promise<A>,
  options?: FetchOptions
): Query.QueryDescriptor<A, unknown> =>
  Query.make<A, unknown>({
    key,
    loader: Effect.tryPromise({ try: () => loader(), catch: (error) => error }),
    staleTime: options?.staleTimeMillis,
    timeToLive: options?.timeToLiveMillis,
    tags: options?.tags,
  });

/**
 * Create a promise/callback client backed by an in-memory cache.
 *
 * ```ts
 * const client = makeClient();
 * const user = await client.fetch(["users", "1"], () => fetchUser("1"));
 * await client.dispose();
 * ```
 */
export const makeClient = (options?: ClientOptions): PromiseClient => {
  const layer = QueryClientModule.layer.pipe(
    Layer.provideMerge(MemoryCacheStore.layer({ maxEntries: options?.maxEntries }))
  );
  const facade = PromiseFacade.make(layer);

  const withClient = <A, E>(
    f: (client: QueryClient) => Effect.Effect<A, E, QueryClient>
  ): Effect.Effect<A, E, QueryClient> => Effect.flatMap(Effect.service(QueryClient), f);

  const fetch = <A>(
    key: SyncKey.SyncKey,
    loader: () => Promise<A>,
    fetchOptions?: FetchOptions
  ): Promise<A> => {
    const descriptor = buildDescriptor(key, loader, fetchOptions);
    return facade.run(
      withClient((client) =>
        fetchOptions?.forceRefresh === true ? client.refetch(descriptor) : client.fetch(descriptor)
      )
    );
  };

  const mutate = <Input, A>(
    key: SyncKey.SyncKey,
    mutator: (input: Input) => Promise<A>,
    input: Input,
    mutateOptions?: {
      readonly invalidates?: ReadonlyArray<SyncKey.SyncKey> | undefined;
      readonly invalidatesTags?: ReadonlyArray<string> | undefined;
    }
  ): Promise<A> =>
    facade.run(
      withClient((client) =>
        client.mutate(
          {
            key,
            execute: (value: Input) =>
              Effect.tryPromise({ try: () => mutator(value), catch: (error) => error }),
            invalidates: mutateOptions?.invalidates,
            invalidatesTags: mutateOptions?.invalidatesTags,
          },
          input
        )
      )
    );

  const getQueryData = <A>(key: SyncKey.SyncKey): Promise<A | undefined> =>
    facade.run(
      withClient((client) =>
        Effect.map(client.getQueryData<A>(key), (option) => Option.getOrUndefined(option))
      )
    );

  const setQueryData = <A>(key: SyncKey.SyncKey, value: A): Promise<void> =>
    facade.run(withClient((client) => client.setQueryData(key, value)));

  const invalidate = (keyPrefix: SyncKey.SyncKey): Promise<void> =>
    facade.run(withClient((client) => client.invalidate(SyncKey.prefixFilter(keyPrefix))));

  const subscribe = <A>(
    key: SyncKey.SyncKey,
    loader: () => Promise<A>,
    callbacks: SubscribeCallbacks<A>,
    subscribeOptions?: FetchOptions
  ): Unsubscribe => {
    const descriptor = buildDescriptor(key, loader, subscribeOptions);
    const stream: Stream.Stream<Query.QueryState<A, unknown>, never, QueryClient> = Stream.unwrap(
      withClient((client) => Effect.succeed(client.observe(descriptor)))
    );
    const subscription = facade.subscribe(stream, {
      onValue: callbacks.onState,
      onDone: callbacks.onDone,
    });
    return () => subscription.unsubscribe();
  };

  return {
    fetch,
    mutate,
    getQueryData,
    setQueryData,
    invalidate,
    subscribe,
    dispose: () => facade.dispose(),
  } satisfies PromiseClient;
};
