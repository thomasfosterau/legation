/**
 * KeyValueStoreAdapter
 *
 * A `CacheStore` implementation backed by Effect's `KeyValueStore`, so the
 * cache can persist to browser storage, the file system, Redis, or SQL by
 * choosing the corresponding `KeyValueStore` layer
 * (`layerStorage`, `layerFileSystem`, `layerSql`, `layerMemory`).
 *
 * ## Serialization
 *
 * Each `CacheEntry` is serialized to a JSON string and stored under the
 * key `effect-sync-core:${SyncKey.hash(entry.key)}`. JSON parse/stringify
 * failures and `KeyValueStoreError`s are mapped to `StoreError` with the
 * original error attached as `cause`.
 *
 * ## Enumeration via an index
 *
 * `KeyValueStore` exposes no key-listing API, but `CacheStore.entries`
 * must be able to enumerate (and filter) every stored entry. This adapter
 * therefore maintains an **index entry**: a JSON array of every stored key
 * hash, kept under the reserved key `effect-sync-core:__index__`. The
 * index is updated transactionally-ish on every `set`/`remove`/`clear`.
 *
 * This is a deliberate design trade-off: it keeps the adapter compatible
 * with any `KeyValueStore` backend at the cost of one extra read/write per
 * mutation and a small consistency window if a process dies between
 * writing an entry and updating the index. For a cache (where missing
 * entries simply trigger a reload) that window is acceptable.
 */

import * as SyncKey from "./SyncKey.js";
import { type CacheEntry, CacheStore } from "./CacheStore.js";
import { StoreError } from "./Errors.js";
import { Effect, Layer, Option } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

/** Prefix applied to every key this adapter writes. */
const KEY_PREFIX = "effect-sync-core:";

/** Reserved key holding the JSON array of stored key hashes. */
const INDEX_KEY = `${KEY_PREFIX}__index__`;

const storeKeyOf = (hash: SyncKey.SyncKeyHash): string => `${KEY_PREFIX}${hash}`;

const mapKvError =
  (method: string) =>
  (cause: KeyValueStore.KeyValueStoreError): StoreError =>
    new StoreError({
      message: `KeyValueStore ${method} failed`,
      cause,
    });

const decodeEntry = (json: string): Effect.Effect<CacheEntry, StoreError> =>
  Effect.try({
    try: () => JSON.parse(json) as CacheEntry,
    catch: (cause) => new StoreError({ message: "Failed to parse cached entry", cause }),
  });

const encodeEntry = (entry: CacheEntry): Effect.Effect<string, StoreError> =>
  Effect.try({
    try: () => JSON.stringify(entry),
    catch: (cause) => new StoreError({ message: "Failed to serialize cache entry", cause }),
  });

/**
 * Build a `CacheStore` backed by the `KeyValueStore` in context.
 */
export const make: Effect.Effect<CacheStore, never, KeyValueStore.KeyValueStore> = Effect.gen(
  function* () {
    const kv = yield* KeyValueStore.KeyValueStore;

    const readIndex: Effect.Effect<Array<string>, StoreError> = kv.get(INDEX_KEY).pipe(
      Effect.mapError(mapKvError("get")),
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed<Array<string>>([])
          : Effect.try({
              try: () => JSON.parse(value) as Array<string>,
              catch: (cause) => new StoreError({ message: "Failed to parse cache index", cause }),
            })
      )
    );

    const writeIndex = (hashes: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
      Effect.try({
        try: () => JSON.stringify(hashes),
        catch: (cause) => new StoreError({ message: "Failed to serialize cache index", cause }),
      }).pipe(
        Effect.flatMap((json) => kv.set(INDEX_KEY, json).pipe(Effect.mapError(mapKvError("set"))))
      );

    const get = (key: SyncKey.SyncKey): Effect.Effect<Option.Option<CacheEntry>, StoreError> =>
      kv.get(storeKeyOf(SyncKey.hash(key))).pipe(
        Effect.mapError(mapKvError("get")),
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(Option.none<CacheEntry>())
            : Effect.map(decodeEntry(value), Option.some)
        )
      );

    const set = (entry: CacheEntry): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const hash = SyncKey.hash(entry.key);
        const json = yield* encodeEntry(entry);
        yield* kv.set(storeKeyOf(hash), json).pipe(Effect.mapError(mapKvError("set")));
        const index = yield* readIndex;
        if (!index.includes(hash)) {
          yield* writeIndex([...index, hash]);
        }
      });

    const remove = (key: SyncKey.SyncKey): Effect.Effect<boolean, StoreError> =>
      Effect.gen(function* () {
        const hash = SyncKey.hash(key);
        const storeKey = storeKeyOf(hash);
        const existed = yield* kv.has(storeKey).pipe(Effect.mapError(mapKvError("has")));
        yield* kv.remove(storeKey).pipe(Effect.mapError(mapKvError("remove")));
        if (existed) {
          const index = yield* readIndex;
          yield* writeIndex(index.filter((h) => h !== hash));
        }
        return existed;
      });

    const entries = (
      filter?: SyncKey.KeyFilter
    ): Effect.Effect<ReadonlyArray<CacheEntry>, StoreError> =>
      Effect.gen(function* () {
        const index = yield* readIndex;
        const loaded = yield* Effect.forEach(index, (hash) =>
          kv.get(storeKeyOf(hash)).pipe(
            Effect.mapError(mapKvError("get")),
            Effect.flatMap((value) =>
              value === undefined
                ? Effect.succeed(Option.none<CacheEntry>())
                : Effect.map(decodeEntry(value), Option.some)
            )
          )
        );
        const all = loaded.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        return filter === undefined
          ? all
          : all.filter((entry) => SyncKey.matches(entry.key, filter));
      });

    const clear: Effect.Effect<void, StoreError> = Effect.gen(function* () {
      const index = yield* readIndex;
      yield* Effect.forEach(
        index,
        (hash) => kv.remove(storeKeyOf(hash)).pipe(Effect.mapError(mapKvError("remove"))),
        { discard: true }
      );
      yield* kv.remove(INDEX_KEY).pipe(Effect.mapError(mapKvError("remove")));
    });

    const size: Effect.Effect<number, StoreError> = Effect.map(readIndex, (index) => index.length);

    return {
      get,
      set,
      remove,
      entries,
      clear,
      size,
    } satisfies CacheStore;
  }
);

/**
 * A layer providing a `CacheStore` backed by the `KeyValueStore` in
 * context.
 *
 * ```ts
 * const store = KeyValueStoreAdapter.layer.pipe(
 *   Layer.provide(KeyValueStore.layerStorage(() => localStorage))
 * );
 * const cache = WriteThroughCache.layer.pipe(Layer.provide(store));
 * ```
 */
export const layer: Layer.Layer<CacheStore, never, KeyValueStore.KeyValueStore> =
  Layer.effect(CacheStore)(make);
