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
 * - `subscribe` / `unsubscribe` — track key filters that are re-sent on reconnect,
 * - `push` — drain the outbox to the server (with backoff on transient failures),
 * - `runSync` — run the background engine: a message pump that streams server
 *   updates and correlates `PushAck` / `PullAck` responses into the cache, and a
 *   reconnect watcher that resubscribes, pulls known keys, and pushes the outbox
 *   whenever the connection comes up.
 *
 * ## Reconnect hardening (issue #13)
 *
 * - **Subscription tracking.** `subscribe` / `unsubscribe` record the active
 *   wire filters in a `Ref`; on every transition to `connected` the recorded
 *   filters are re-sent.
 * - **Pull-on-reconnect.** `SyncCache` has no "list all keys" API, so the client
 *   instead tracks the set of keys it knows the server has synced — added when an
 *   `Updated` / `PullAck` entry arrives and when a push is `Applied` — and issues a
 *   single `Pull` for exactly those keys on reconnect. The keys are kept in a
 *   `Ref<Map<SyncKeyHash, SyncKey>>` so they de-duplicate by structural hash while
 *   preserving the original key for the wire message.
 * - **PushAck correlation.** Every `Push` carries a generated message id and the
 *   client remembers the message id → outbox entries it sent. When the matching
 *   `PushAck` arrives each per-mutation result is reconciled: `Applied` discards
 *   the entry and writes the server entry; `Conflict` is resolved by the
 *   configured `ConflictStrategy`; `Rejected` discards and warns. Outbox entries
 *   are no longer discarded blindly on send.
 * - **Backoff.** `push` retries transient `TransportError`s with an exponential
 *   schedule capped at five attempts.
 */

import { Context, Duration, Effect, Layer, Schedule, Stream } from "effect";
import * as Mutation from "./Mutation.js";
import * as Outbox from "./Outbox.js";
import * as Protocol from "./Protocol.js";
import * as Query from "./Query.js";
import * as SyncCache from "./SyncCache.js";
import * as SyncKey from "./SyncKey.js";
import * as Transport from "./Transport.js";
import * as Versioned from "./Versioned.js";
import { type OutboxError, type StoreError, type TransportError } from "./Errors.js";
import { Ref } from "effect";
import type { Scope } from "effect";
import * as QueryClientModule from "./QueryClient.js";
import { applyFanout } from "./Subscriptions.js";

const QueryClient = QueryClientModule.QueryClient;
type QueryClient = QueryClientModule.QueryClient;

/**
 * Options for building a {@link SyncClient}.
 */
export interface SyncClientOptions {
  /**
   * How to resolve a `Conflict` reported by the server for a pushed mutation.
   * Defaults to `"preferRemote"`.
   */
  readonly conflictStrategy?: Versioned.ConflictStrategy<unknown> | undefined;
}

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
   * Subscribe to keys matching a wire filter: send a `Subscribe` message and
   * record the filter so it is re-sent automatically after a reconnect.
   */
  readonly subscribe: (filter: Protocol.WireKeyFilter) => Effect.Effect<void, TransportError>;
  /**
   * Unsubscribe from keys matching a wire filter: send an `Unsubscribe`
   * message and stop tracking the filter for resubscription.
   */
  readonly unsubscribe: (filter: Protocol.WireKeyFilter) => Effect.Effect<void, TransportError>;
  /**
   * Push pending outbox entries to the server in a single `Push` message.
   *
   * Entries are *not* discarded on send: they remain in the outbox until the
   * correlated `PushAck` arrives and is reconciled by the message pump.
   * Transient `TransportError`s are retried with exponential backoff.
   */
  readonly push: Effect.Effect<void, TransportError | StoreError | OutboxError>;
  /**
   * Run the background sync engine until the surrounding scope closes:
   * a message pump (server fan-out + `PushAck` / `PullAck` correlation) and a
   * reconnect watcher that resubscribes, pulls known keys, and pushes the
   * outbox on every transition to `connected`.
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
  "@thomasfosterau/effect-sync-core/SyncClient"
);

let messageCounter = 0;

/**
 * Generate a unique client message id.
 */
const nextMessageId = (): string => {
  messageCounter += 1;
  return `client-msg-${messageCounter}`;
};

/**
 * Build a `SyncClient` from a `QueryClient`, `Outbox`, `ClientTransport`,
 * and `SyncCache` in context.
 *
 * @param options - optional {@link SyncClientOptions}; `make()` with no
 *   argument is supported and uses the defaults (`conflictStrategy:
 *   "preferRemote"`).
 */
export const make = (
  options?: SyncClientOptions
): Effect.Effect<
  SyncClient,
  never,
  QueryClient | Outbox.Outbox | Transport.ClientTransport | SyncCache.SyncCache
> =>
  Effect.gen(function* () {
    const client = yield* QueryClient;
    const outbox = yield* Outbox.Outbox;
    const transport = yield* Transport.ClientTransport;
    const cache = yield* SyncCache.SyncCache;

    const conflictStrategy: Versioned.ConflictStrategy<unknown> =
      options?.conflictStrategy ?? "preferRemote";

    // Active subscription filters, re-sent on reconnect.
    const subscriptions = yield* Ref.make<ReadonlyArray<Protocol.WireKeyFilter>>([]);

    // Keys the client knows the server has synced (by structural hash, with
    // the original key preserved for the wire `Pull`). Populated from
    // `Updated` / `PullAck` entries and from `Applied` push results.
    const knownKeys = yield* Ref.make(new Map<SyncKey.SyncKeyHash, SyncKey.SyncKey>());

    // Message id -> the outbox entries that the Push carried, so PushAck
    // results (which only carry `mutationId` / `key`) can be reconciled
    // against the original input for re-push on `preferLocal`.
    const inFlightPushes = yield* Ref.make(
      new Map<Protocol.MessageId, ReadonlyArray<Outbox.OutboxEntry>>()
    );

    const rememberKey = (key: SyncKey.SyncKey): Effect.Effect<void> =>
      Ref.update(knownKeys, (map) => {
        const next = new Map(map);
        next.set(SyncKey.hash(key), key);
        return next;
      });

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

    const subscribe = (filter: Protocol.WireKeyFilter): Effect.Effect<void, TransportError> =>
      Effect.gen(function* () {
        yield* Ref.update(subscriptions, (filters) =>
          filters.some((existing) => filtersEqual(existing, filter))
            ? filters
            : [...filters, filter]
        );
        yield* transport.send({ _tag: "Subscribe", id: nextMessageId(), filter });
      });

    const unsubscribe = (filter: Protocol.WireKeyFilter): Effect.Effect<void, TransportError> =>
      Effect.gen(function* () {
        yield* Ref.update(subscriptions, (filters) =>
          filters.filter((existing) => !filtersEqual(existing, filter))
        );
        yield* transport.send({ _tag: "Unsubscribe", id: nextMessageId(), filter });
      });

    // Send a single Push for all pending entries, recording the message id ->
    // entries mapping so PushAck can be correlated. Entries stay in the outbox
    // until their ack arrives. Transient transport failures are retried with
    // exponential backoff.
    const sendPush: Effect.Effect<void, TransportError | StoreError> = Effect.gen(function* () {
      const pending = yield* outbox.entries;
      if (pending.length === 0) {
        return;
      }

      const id = nextMessageId();
      const mutations: ReadonlyArray<Protocol.PushMutation> = pending.map((entry) => ({
        mutationId: entry.id,
        key: entry.mutationKey,
        input: entry.input,
      }));

      yield* Ref.update(inFlightPushes, (map) => {
        const next = new Map(map);
        next.set(id, pending);
        return next;
      });

      yield* transport.send({ _tag: "Push", id, mutations });
    });

    const retrySchedule = Schedule.both(
      Schedule.exponential(Duration.millis(100)),
      Schedule.recurs(5)
    );

    const push: SyncClient["push"] = Effect.retry(sendPush, retrySchedule);

    // Re-push a single mutation with an explicit base version, used by the
    // `preferLocal` conflict resolution so the server applies it next time.
    const rePushWithBaseVersion = (
      entry: Outbox.OutboxEntry,
      baseVersion: Versioned.Version
    ): Effect.Effect<void, TransportError> => {
      const id = nextMessageId();
      const mutation: Protocol.PushMutation = {
        mutationId: entry.id,
        key: entry.mutationKey,
        input: entry.input,
        baseVersion,
      };
      return Ref.update(inFlightPushes, (map) => {
        const next = new Map(map);
        next.set(id, [entry]);
        return next;
      }).pipe(Effect.andThen(transport.send({ _tag: "Push", id, mutations: [mutation] })));
    };

    // Reconcile one PushAck result against the outbox and cache.
    const handlePushResult = (
      result: Protocol.PushResult
    ): Effect.Effect<void, StoreError | TransportError> => {
      switch (result._tag) {
        case "Applied":
          return Effect.gen(function* () {
            yield* outbox.discard(result.mutationId);
            yield* cache.set(result.entry.key, result.entry.value, {
              version: result.entry.version,
            });
            yield* rememberKey(result.entry.key);
          });
        case "Conflict":
          return Effect.gen(function* () {
            const acceptRemote = Effect.gen(function* () {
              yield* cache.set(result.serverEntry.key, result.serverEntry.value, {
                version: result.serverEntry.version,
              });
              yield* rememberKey(result.serverEntry.key);
              yield* outbox.discard(result.mutationId);
            });

            if (conflictStrategy === "preferRemote") {
              yield* acceptRemote;
              return;
            }

            if (conflictStrategy === "preferLocal") {
              // Re-push the local mutation, telling the server which version
              // we are now based on so it applies next time. The conflicting
              // mutation is located by its `mutationId` across every in-flight
              // push (servers may not echo the request id we generated).
              const entry = findInFlightEntry(yield* Ref.get(inFlightPushes), result.mutationId);
              if (entry !== undefined) {
                yield* rePushWithBaseVersion(entry, result.serverEntry.version);
              }
              return;
            }

            if (conflictStrategy === "fail") {
              // `fail` cannot surface synchronously from a background pump, so
              // we keep the local optimistic value and the entry queued, and
              // warn. The next reconnect/push re-attempts delivery.
              yield* Effect.logWarning(
                `Conflict for key ${SyncKey.hash(result.key)} with strategy "fail"; ` +
                  `keeping local value and leaving the mutation queued.`
              );
              return;
            }

            // `lastWriteWins` or a custom merge function: resolve against the
            // local cache value (falling back to the server entry's metadata
            // when we have nothing locally), write the winner, and discard the
            // entry. Simplification: a custom merge sees the locally-cached
            // value, not the un-applied mutation input.
            const local = yield* cache.peek(result.serverEntry.key);
            const remote = Versioned.make(
              result.serverEntry.value,
              result.serverEntry.version,
              result.serverEntry.updatedAt
            );
            const localVersioned =
              local._tag === "Some"
                ? Versioned.make(
                    local.value.value,
                    result.serverEntry.version,
                    local.value.updatedAt
                  )
                : remote;
            const resolved = yield* Versioned.resolve({
              key: result.serverEntry.key,
              local: localVersioned,
              remote,
              strategy: conflictStrategy,
            }).pipe(Effect.orElseSucceed(() => remote));
            yield* cache.set(result.serverEntry.key, resolved.value, {
              version: resolved.version,
            });
            yield* rememberKey(result.serverEntry.key);
            yield* outbox.discard(result.mutationId);
          });
        case "Rejected":
          return Effect.gen(function* () {
            yield* outbox.discard(result.mutationId);
            yield* Effect.logWarning(
              `Push for key ${SyncKey.hash(result.key)} rejected by server: ${result.reason}`
            );
          });
      }
    };

    const handlePushAck = (
      message: Extract<Protocol.ServerMessage, { _tag: "PushAck" }>
    ): Effect.Effect<void, StoreError | TransportError> =>
      Effect.gen(function* () {
        yield* Effect.forEach(message.results, handlePushResult, { discard: true });
        // Forget the now-reconciled mutations from every in-flight push so the
        // map cannot grow unbounded. Servers may not echo our request id, so
        // we prune by the acked `mutationId`s rather than by `message.id`.
        const acked = new Set(message.results.map((result) => result.mutationId));
        yield* Ref.update(inFlightPushes, (map) => {
          const next = new Map<Protocol.MessageId, ReadonlyArray<Outbox.OutboxEntry>>();
          for (const [id, entries] of map) {
            const remaining = entries.filter((entry) => !acked.has(entry.id));
            if (remaining.length > 0) {
              next.set(id, remaining);
            }
          }
          return next;
        });
      });

    const handlePullAck = (
      message: Extract<Protocol.ServerMessage, { _tag: "PullAck" }>
    ): Effect.Effect<void, StoreError> =>
      Effect.forEach(
        message.entries,
        (entry) =>
          Effect.gen(function* () {
            yield* cache.set(entry.key, entry.value, { version: entry.version });
            yield* rememberKey(entry.key);
          }),
        { discard: true }
      );

    // The message pump: fan-out via the shared Subscriptions helper, plus
    // PushAck / PullAck correlation. `Updated` entries are also remembered as
    // known keys so they are pulled on reconnect.
    const messagePump: Effect.Effect<void, StoreError | TransportError> = Stream.runForEach(
      transport.messages,
      (message) => {
        switch (message._tag) {
          case "PushAck":
            return handlePushAck(message);
          case "PullAck":
            return handlePullAck(message);
          case "Updated":
            return applyFanout(cache, message).pipe(Effect.andThen(rememberKey(message.entry.key)));
          default:
            return applyFanout(cache, message);
        }
      }
    );

    // On every transition to "connected": resubscribe all recorded filters,
    // pull all known keys, then push the outbox.
    const onReconnect: Effect.Effect<void, TransportError | StoreError | OutboxError> = Effect.gen(
      function* () {
        const filters = yield* Ref.get(subscriptions);
        yield* Effect.forEach(
          filters,
          (filter) => transport.send({ _tag: "Subscribe", id: nextMessageId(), filter }),
          { discard: true }
        );

        const keys = Array.from((yield* Ref.get(knownKeys)).values());
        if (keys.length > 0) {
          yield* transport.send({ _tag: "Pull", id: nextMessageId(), keys });
        }

        yield* push;
      }
    );

    const runSync: SyncClient["runSync"] = Effect.gen(function* () {
      yield* Effect.forkScoped(messagePump);
      yield* Stream.runForEach(transport.statusChanges, (status) =>
        status === "connected" ? onReconnect : Effect.void
      );
    });

    return {
      query,
      mutateLocal,
      subscribe,
      unsubscribe,
      push,
      runSync,
    } satisfies SyncClient;
  });

/**
 * Find the in-flight outbox entry for a mutation id across every recorded
 * push. Servers may not echo the request message id, so push results are
 * located by their stable `mutationId` (the outbox entry id).
 */
const findInFlightEntry = (
  pushes: ReadonlyMap<Protocol.MessageId, ReadonlyArray<Outbox.OutboxEntry>>,
  mutationId: string
): Outbox.OutboxEntry | undefined => {
  for (const entries of pushes.values()) {
    const found = entries.find((entry) => entry.id === mutationId);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The key or prefix a wire filter selects on. */
const filterKey = (filter: Protocol.WireKeyFilter): SyncKey.SyncKey =>
  filter._tag === "Exact" ? filter.key : filter.prefix;

/**
 * Structural equality between two wire filters.
 */
const filtersEqual = (a: Protocol.WireKeyFilter, b: Protocol.WireKeyFilter): boolean =>
  a._tag === b._tag && SyncKey.equals(filterKey(a), filterKey(b));

/**
 * A layer providing the client sync engine.
 *
 * Requires a `QueryClient`, `Outbox`, `ClientTransport`, and `SyncCache` to
 * be provided. Compose `QueryClient.layer` / `Outbox.layer` /
 * `SyncCache.layer` and a transport underneath it.
 *
 * @param options - optional {@link SyncClientOptions}. Note this is a
 *   function (`layer(options)`), not a constant.
 */
export const layer = (
  options?: SyncClientOptions
): Layer.Layer<
  SyncClient,
  never,
  QueryClient | Outbox.Outbox | Transport.ClientTransport | SyncCache.SyncCache
> => Layer.effect(SyncClient)(make(options));
