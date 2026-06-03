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
 *
 * ## Validation and corruption policy
 *
 * Stored JSON is untrusted: another process, an older version of this code,
 * or a third party with access to the backend may have written it. Every
 * parsed entry is therefore validated against `CacheEntrySchema` before it
 * is handed to the engine. A **corrupted entry** (one that parses as JSON
 * but does not match the schema, or that is not valid JSON at all) is
 * treated as a **cache miss**: `get` returns `Option.none` and `entries`
 * skips it, rather than failing the whole operation. Because this is a
 * cache, a miss simply triggers a reload from the source of truth. Each
 * such event is logged with `Effect.logWarning` so corruption is
 * observable. A corrupted **index**, by contrast, is a `StoreError`: the
 * index is internal bookkeeping, not reloadable data, so silently dropping
 * it would orphan otherwise-valid entries.
 */

import * as SyncKey from "./SyncKey.js";
import { type CacheEntry, CacheStore } from "./CacheStore.js";
import { StoreError } from "./Errors.js";
import { Effect, Layer, Option, Schema } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { SyncKeySchema } from "./ProtocolSchema.js";

/**
 * Schema for a persisted `CacheEntry`. The `value` is arbitrary, so it is
 * `Schema.Unknown`; timing fields are numbers (nullable where the entry
 * never goes stale / never expires); `version` is an optional string or
 * number; `tags` is an array of strings.
 */
const CacheEntrySchema: Schema.Codec<CacheEntry> = Schema.Struct({
  key: SyncKeySchema,
  value: Schema.Unknown,
  updatedAt: Schema.Number,
  staleAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  version: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  tags: Schema.Array(Schema.String),
}) as Schema.Codec<CacheEntry>;

/** Schema for the enumeration index: a JSON array of stored key hashes. */
const IndexSchema = Schema.Array(Schema.String);

const decodeEntrySchema = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheEntrySchema));
const decodeIndexSchema = Schema.decodeUnknownEffect(Schema.fromJsonString(IndexSchema));

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

/**
 * Validate and decode a stored entry. A value that is not valid JSON or
 * does not match `CacheEntrySchema` is treated as a cache miss
 * (`Option.none`) and logged, rather than failing the operation.
 */
const decodeEntry = (
  hash: string,
  json: string
): Effect.Effect<Option.Option<CacheEntry>, StoreError> =>
  decodeEntrySchema(json).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SchemaError", (cause) =>
      Effect.logWarning("Discarding corrupted cache entry", { hash, cause }).pipe(
        Effect.as(Option.none<CacheEntry>())
      )
    )
  );

const encodeEntry = (entry: CacheEntry): Effect.Effect<string, StoreError> =>
  Schema.encodeEffect(Schema.fromJsonString(CacheEntrySchema))(entry).pipe(
    Effect.mapError(
      (cause) => new StoreError({ message: "Failed to serialize cache entry", cause })
    )
  );

/**
 * Build a `CacheStore` backed by the `KeyValueStore` in context.
 */
export const make: Effect.Effect<CacheStore, never, KeyValueStore.KeyValueStore> = Effect.gen(
  function* () {
    const kv = yield* KeyValueStore.KeyValueStore;

    const readIndex: Effect.Effect<ReadonlyArray<string>, StoreError> = kv.get(INDEX_KEY).pipe(
      Effect.mapError(mapKvError("get")),
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed<ReadonlyArray<string>>([])
          : decodeIndexSchema(value).pipe(
              Effect.mapError(
                (cause) => new StoreError({ message: "Failed to parse cache index", cause })
              )
            )
      )
    );

    const writeIndex = (hashes: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
      Schema.encodeEffect(Schema.fromJsonString(IndexSchema))(hashes).pipe(
        Effect.mapError(
          (cause) => new StoreError({ message: "Failed to serialize cache index", cause })
        ),
        Effect.flatMap((json) => kv.set(INDEX_KEY, json).pipe(Effect.mapError(mapKvError("set"))))
      );

    const get = (key: SyncKey.SyncKey): Effect.Effect<Option.Option<CacheEntry>, StoreError> => {
      const hash = SyncKey.hash(key);
      return kv.get(storeKeyOf(hash)).pipe(
        Effect.mapError(mapKvError("get")),
        Effect.flatMap((value) =>
          value === undefined ? Effect.succeed(Option.none<CacheEntry>()) : decodeEntry(hash, value)
        )
      );
    };

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
                : decodeEntry(hash, value)
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
