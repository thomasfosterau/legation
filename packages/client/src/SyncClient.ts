/**
 * SyncClient
 *
 * The full offline-capable client sync engine. It combines the
 * `QueryClient` (read/observe/mutate against the local cache), the durable
 * `Outbox` (queue mutations while offline), and the `ClientTransport`
 * (push to and receive from the server).
 *
 * A `SyncClient` lets callers:
 *
 * - `query` data through the cache,
 * - `mutateLocal` — apply a mutation locally *and* enqueue it for delivery,
 * - `push` — drain the outbox to the server,
 * - `runSync` — run the background engine: stream server updates into the
 *   cache and push the outbox whenever the connection comes up.
 */

import { Context, Effect, Layer, Stream } from "effect";
import {
  Mutation,
  Outbox,
  Protocol,
  Query,
  SyncCache,
  Transport,
  type OutboxError,
  type StoreError,
  type TransportError,
} from "@thomasfosterau/effect-sync-core";
import type { Scope } from "effect";
import * as QueryClientModule from "./QueryClient.js";
import { runSubscriptions } from "./Subscriptions.js";

const QueryClient = QueryClientModule.QueryClient;
type QueryClient = QueryClientModule.QueryClient;

/**
 * The offline-capable client sync engine service.
 */
export interface SyncClient {
  /** Read-through query against the local cache. */
  readonly query: <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ) => Effect.Effect<A, E | StoreError, R>;
  /**
   * Apply a mutation locally (optimistic patches against the cache) *and*
   * enqueue it in the outbox for later delivery to the server.
   */
  readonly mutateLocal: <Input, A, E, R>(
    descriptor: Mutation.MutationDescriptor<Input, A, E, R>,
    input: Input
  ) => Effect.Effect<A, E | StoreError, R>;
  /**
   * Push pending outbox entries to the server in a single `Push` message.
   * On a successful send the entries are removed from the outbox.
   */
  readonly push: Effect.Effect<void, TransportError | StoreError | OutboxError>;
  /**
   * Run the background sync engine until the surrounding scope closes:
   * fork {@link runSubscriptions} to stream server updates into the cache,
   * and push the outbox whenever the transport reports `connected`.
   */
  readonly runSync: Effect.Effect<
    void,
    TransportError | StoreError | OutboxError,
    Scope.Scope | Transport.ClientTransport | SyncCache.SyncCache
  >;
}

/**
 * Service key for the client sync engine.
 */
export const SyncClient = Context.Service<SyncClient>(
  "@thomasfosterau/effect-sync-client/SyncClient"
);

/**
 * Build a `SyncClient` from a `QueryClient`, `Outbox`, `ClientTransport`,
 * and `SyncCache` in context.
 */
export const make: Effect.Effect<
  SyncClient,
  never,
  QueryClient | Outbox.Outbox | Transport.ClientTransport | SyncCache.SyncCache
> = Effect.gen(function* () {
  const client = yield* QueryClient;
  const outbox = yield* Outbox.Outbox;
  const transport = yield* Transport.ClientTransport;
  const cache = yield* SyncCache.SyncCache;

  const query = <A, E, R>(
    descriptor: Query.QueryDescriptor<A, E, R>
  ): Effect.Effect<A, E | StoreError, R> => client.fetch(descriptor);

  const mutateLocal = <Input, A, E, R>(
    descriptor: Mutation.MutationDescriptor<Input, A, E, R>,
    input: Input
  ): Effect.Effect<A, E | StoreError, R> =>
    Effect.gen(function* () {
      const result = yield* Mutation.execute(cache, descriptor, input);
      yield* outbox.enqueue(descriptor.key, input);
      return result;
    });

  // Build a single Push message from all pending outbox entries and send
  // it; on a successful send the entries are discarded via outbox.drain
  // (the deliver effect succeeds for every entry once the send lands).
  const push: SyncClient["push"] = Effect.gen(function* () {
    const pending = yield* outbox.entries;
    if (pending.length === 0) {
      return;
    }

    const mutations: ReadonlyArray<Protocol.PushMutation> = pending.map((entry) => ({
      mutationId: entry.id,
      key: entry.mutationKey,
      input: entry.input,
    }));

    yield* transport.send({ _tag: "Push", id: `push-${pending[0]!.id}`, mutations });

    // The send succeeded, so every pending entry has been delivered:
    // drain discards each one (deliver is a no-op success per entry).
    yield* outbox.drain(() => Effect.void);
  });

  const runSync: SyncClient["runSync"] = Effect.gen(function* () {
    yield* Effect.forkScoped(runSubscriptions);
    yield* Stream.runForEach(transport.statusChanges, (status) =>
      status === "connected" ? push : Effect.void
    );
  });

  return {
    query,
    mutateLocal,
    push,
    runSync,
  } satisfies SyncClient;
});

/**
 * A layer providing the client sync engine.
 *
 * Requires a `QueryClient`, `Outbox`, `ClientTransport`, and `SyncCache` to
 * be provided. Compose `QueryClient.layer` / `Outbox.layer` /
 * `SyncCache.layer` and a transport underneath it.
 */
export const layer: Layer.Layer<
  SyncClient,
  never,
  QueryClient | Outbox.Outbox | Transport.ClientTransport | SyncCache.SyncCache
> = Layer.effect(SyncClient)(make);
