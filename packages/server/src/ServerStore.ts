/**
 * ServerStore
 *
 * The server's backing data store — the authoritative source of truth that
 * the sync engine writes through to and fans out from. Each stored entry
 * carries a monotonically increasing version (starting at 1) used for
 * conflict detection against client-supplied base versions.
 *
 * The in-memory `memoryLayer` is provided for tests, prototypes, and
 * single-process deployments. Production deployments implement this
 * interface over their real database (Postgres, DynamoDB, etc.), preserving
 * the per-key version semantics.
 */

import { Clock, Context, Effect, Layer, Option, Ref } from "effect";
import type { StoreError } from "@thomasfosterau/effect-sync-core";
import { SyncKey } from "@thomasfosterau/effect-sync-core";

type KeyFilter = SyncKey.KeyFilter;
type SyncKeyHash = SyncKey.SyncKeyHash;

/**
 * A single authoritative entry held by the server's backing store.
 */
export interface StoredEntry {
  /** The key this entry is stored under. */
  readonly key: SyncKey.SyncKey;
  /** The authoritative value. */
  readonly value: unknown;
  /** Monotonically increasing version, starting at 1. */
  readonly version: number;
  /** Epoch milliseconds when the entry was last written. */
  readonly updatedAt: number;
}

/**
 * The server's backing data store (source of truth).
 *
 * Implementations are responsible only for persistence and version
 * bookkeeping; conflict policy and fan-out live in `SyncHub`.
 */
export interface ServerStore {
  /** Read the entry stored under `key`, if any. */
  readonly get: (key: SyncKey.SyncKey) => Effect.Effect<Option.Option<StoredEntry>, StoreError>;
  /**
   * Write a value under `key`, bumping its version (new keys start at 1).
   * Returns the newly stored entry.
   */
  readonly set: (key: SyncKey.SyncKey, value: unknown) => Effect.Effect<StoredEntry, StoreError>;
  /** Remove the entry stored under `key`, returning it when present. */
  readonly remove: (key: SyncKey.SyncKey) => Effect.Effect<Option.Option<StoredEntry>, StoreError>;
  /** List all entries matching a key filter (all entries when no filter given). */
  readonly list: (filter?: KeyFilter) => Effect.Effect<ReadonlyArray<StoredEntry>, StoreError>;
}

/**
 * Service key for the server's backing store.
 */
export const ServerStore = Context.Service<ServerStore>(
  "@thomasfosterau/effect-sync-server/ServerStore"
);

/**
 * Construct an in-memory `ServerStore` backed by a `Ref<Map>` keyed by
 * `SyncKey.hash`.
 */
export const make: Effect.Effect<ServerStore> = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<SyncKeyHash, StoredEntry>());

  const get = (key: SyncKey.SyncKey): Effect.Effect<Option.Option<StoredEntry>, StoreError> =>
    Effect.map(Ref.get(entries), (map) => Option.fromUndefinedOr(map.get(SyncKey.hash(key))));

  const set = (key: SyncKey.SyncKey, value: unknown): Effect.Effect<StoredEntry, StoreError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(entries, (map) => {
        const keyHash = SyncKey.hash(key);
        const previous = map.get(keyHash);
        const entry: StoredEntry = {
          key,
          value,
          version: previous === undefined ? 1 : previous.version + 1,
          updatedAt: now,
        };
        const next = new Map(map);
        next.set(keyHash, entry);
        return [entry, next];
      });
    });

  const remove = (key: SyncKey.SyncKey): Effect.Effect<Option.Option<StoredEntry>, StoreError> =>
    Ref.modify(entries, (map) => {
      const keyHash = SyncKey.hash(key);
      const previous = map.get(keyHash);
      if (previous === undefined) {
        return [Option.none<StoredEntry>(), map];
      }
      const next = new Map(map);
      next.delete(keyHash);
      return [Option.some(previous), next];
    });

  const list = (filter?: KeyFilter): Effect.Effect<ReadonlyArray<StoredEntry>, StoreError> =>
    Effect.map(Ref.get(entries), (map) => {
      const all = Array.from(map.values());
      return filter === undefined ? all : all.filter((entry) => SyncKey.matches(entry.key, filter));
    });

  return { get, set, remove, list } satisfies ServerStore;
});

/**
 * A layer providing an in-memory, `Map`-backed `ServerStore`.
 *
 * Production deployments replace this with a layer that implements the same
 * interface over their database of record.
 */
export const memoryLayer: Layer.Layer<ServerStore> = Layer.effect(ServerStore)(make);
