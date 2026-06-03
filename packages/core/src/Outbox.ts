/**
 * Outbox
 *
 * A durable queue of pending mutations, used for offline-first clients.
 * Mutations enqueued while offline are persisted in the `CacheStore`
 * (under a reserved key prefix) so they survive restarts when the store
 * is durable, and are drained when connectivity returns.
 */

import { Clock, Context, Effect, Layer, Option, PubSub, Ref, Scope, Stream } from "effect";
import { CacheStore } from "./CacheStore.js";
import { OutboxError, StoreError } from "./Errors.js";
import * as SyncKey from "./SyncKey.js";

/**
 * Reserved key prefix under which outbox entries are stored.
 */
export const outboxKeyPrefix: SyncKey.SyncKey = ["__effect-sync-outbox__"];

/**
 * Status of an outbox entry.
 */
export type OutboxEntryStatus = "pending" | "in-flight" | "failed";

/**
 * A queued mutation waiting to be pushed upstream.
 */
export interface OutboxEntry {
  /** Unique entry id, monotonic per outbox. */
  readonly id: string;
  /** The mutation descriptor's key. */
  readonly mutationKey: SyncKey.SyncKey;
  /** The mutation input (must be serializable for durable stores). */
  readonly input: unknown;
  readonly createdAt: number;
  readonly attempts: number;
  readonly status: OutboxEntryStatus;
  readonly lastError?: string | undefined;
}

/**
 * Events published when the outbox changes.
 */
export type OutboxEvent =
  | { readonly _tag: "Enqueued"; readonly entry: OutboxEntry }
  | { readonly _tag: "Completed"; readonly entry: OutboxEntry }
  | { readonly _tag: "Failed"; readonly entry: OutboxEntry }
  | { readonly _tag: "Drained"; readonly remaining: number };

/**
 * Result of draining the outbox.
 */
export interface DrainResult {
  readonly completed: number;
  readonly failed: number;
  readonly remaining: number;
}

/**
 * The outbox service.
 */
export interface Outbox {
  /** Queue a mutation for later delivery. */
  readonly enqueue: (
    mutationKey: SyncKey.SyncKey,
    input: unknown
  ) => Effect.Effect<OutboxEntry, StoreError>;
  /** Entries that have not been delivered yet, oldest first. */
  readonly entries: Effect.Effect<ReadonlyArray<OutboxEntry>, StoreError>;
  /** Remove an entry without delivering it. */
  readonly discard: (id: string) => Effect.Effect<boolean, StoreError>;
  /** Number of undelivered entries. */
  readonly size: Effect.Effect<number, StoreError>;
  /**
   * Deliver pending entries oldest-first using `deliver`.
   *
   * Entries whose delivery succeeds are removed; entries whose delivery
   * fails are marked `failed` (and remain for the next drain) unless they
   * have exceeded `maxAttempts`, in which case they are dropped.
   */
  readonly drain: <E, R>(
    deliver: (entry: OutboxEntry) => Effect.Effect<unknown, E, R>,
    options?: { readonly maxAttempts?: number | undefined }
  ) => Effect.Effect<DrainResult, StoreError | OutboxError, R>;
  /** Outbox change events. */
  readonly events: Stream.Stream<OutboxEvent>;
}

/**
 * Service key for the outbox.
 */
export const Outbox = Context.Service<Outbox>("@thomasfosterau/effect-sync-core/Outbox");

const entryKey = (id: string): SyncKey.SyncKey => [...outboxKeyPrefix, id];

/**
 * Build an `Outbox` backed by the `CacheStore` in context.
 */
export const make: Effect.Effect<Outbox, never, CacheStore | Scope.Scope> = Effect.gen(
  function* () {
    const store = yield* CacheStore;
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<OutboxEvent>(), (ps) =>
      PubSub.shutdown(ps)
    );
    const counter = yield* Ref.make(0);

    const publish = (event: OutboxEvent): Effect.Effect<void> =>
      Effect.asVoid(PubSub.publish(pubsub, event));

    const persist = (entry: OutboxEntry): Effect.Effect<void, StoreError> =>
      store.set({
        key: entryKey(entry.id),
        value: entry,
        updatedAt: entry.createdAt,
        staleAt: null,
        expiresAt: null,
        version: undefined,
        tags: [],
      });

    const listEntries: Effect.Effect<ReadonlyArray<OutboxEntry>, StoreError> = Effect.map(
      store.entries(SyncKey.prefixFilter(outboxKeyPrefix)),
      (entries) =>
        entries
          .map((entry) => entry.value as OutboxEntry)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    );

    const enqueue = (
      mutationKey: SyncKey.SyncKey,
      input: unknown
    ): Effect.Effect<OutboxEntry, StoreError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const count = yield* Ref.updateAndGet(counter, (n) => n + 1);
        // Lexicographically-ordered ids: timestamp + counter.
        const id = `${now.toString().padStart(15, "0")}-${count.toString().padStart(9, "0")}`;
        const entry: OutboxEntry = {
          id,
          mutationKey,
          input,
          createdAt: now,
          attempts: 0,
          status: "pending",
        };
        yield* persist(entry);
        yield* publish({ _tag: "Enqueued", entry });
        return entry;
      });

    const discard = (id: string): Effect.Effect<boolean, StoreError> => store.remove(entryKey(id));

    const size = Effect.map(listEntries, (entries) => entries.length);

    const drain = <E, R>(
      deliver: (entry: OutboxEntry) => Effect.Effect<unknown, E, R>,
      options?: { readonly maxAttempts?: number | undefined }
    ): Effect.Effect<DrainResult, StoreError | OutboxError, R> =>
      Effect.gen(function* () {
        const maxAttempts = options?.maxAttempts ?? Number.POSITIVE_INFINITY;
        const pending = yield* listEntries;
        let completed = 0;
        let failed = 0;

        for (const entry of pending) {
          const attempt: OutboxEntry = {
            ...entry,
            attempts: entry.attempts + 1,
            status: "in-flight",
          };
          const result = yield* Effect.result(deliver(attempt));

          if (result._tag === "Success") {
            yield* discard(entry.id);
            yield* publish({ _tag: "Completed", entry: attempt });
            completed += 1;
          } else {
            failed += 1;
            if (attempt.attempts >= maxAttempts) {
              // Exhausted: drop the entry so it cannot block the queue forever.
              yield* discard(entry.id);
              yield* publish({ _tag: "Failed", entry: { ...attempt, status: "failed" } });
            } else {
              const failedEntry: OutboxEntry = {
                ...attempt,
                status: "failed",
                lastError: String(result.failure),
              };
              yield* persist(failedEntry);
              yield* publish({ _tag: "Failed", entry: failedEntry });
            }
          }
        }

        const remaining = yield* size;
        yield* publish({ _tag: "Drained", remaining });
        return { completed, failed, remaining } satisfies DrainResult;
      });

    return {
      enqueue,
      entries: listEntries,
      discard,
      size,
      drain,
      events: Stream.fromPubSub(pubsub),
    } satisfies Outbox;
  }
);

/**
 * A layer providing the outbox, requiring a `CacheStore`.
 */
export const layer: Layer.Layer<Outbox, never, CacheStore> = Layer.effect(Outbox)(make);

/**
 * Filter cache entries so outbox bookkeeping entries are excluded.
 * Useful for cache stores shared between the cache engine and the outbox.
 */
export const isOutboxKey = (key: SyncKey.SyncKey): boolean =>
  SyncKey.startsWith(key, outboxKeyPrefix);

/**
 * Peek at an outbox entry by id.
 */
export const peek = (
  store: CacheStore,
  id: string
): Effect.Effect<Option.Option<OutboxEntry>, StoreError> =>
  Effect.map(store.get(entryKey(id)), (option) =>
    Option.map(option, (entry) => entry.value as OutboxEntry)
  );
