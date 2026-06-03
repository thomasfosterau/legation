/**
 * IndexedDbCacheStore
 *
 * A `CacheStore` backed by IndexedDB, for durable offline-first caching in
 * browsers.
 *
 * Built by composing two blessed pieces rather than hand-rolling IndexedDB
 * plumbing:
 *
 * - `@effect/platform-browser`'s `BrowserKeyValueStore.layerIndexedDb` — the
 *   official IndexedDB-backed `KeyValueStore`
 * - core's `KeyValueStoreAdapter` — bridges any Effect `KeyValueStore` into a
 *   sync-engine `CacheStore` (JSON + schema-validated entries, prefix
 *   scanning via a maintained index)
 *
 * Values must be JSON-serializable (the same constraint as every other
 * `KeyValueStore`-backed cache store).
 *
 * The underlying IndexedDB connection is a resource: it stays open for the
 * lifetime of the layer (or, for {@link make}, the surrounding `Scope`).
 *
 * In browser windows the IndexedDB primitives come from `window.indexedDB`
 * by default. In other environments (tests, workers with unusual globals),
 * pass an explicit `IndexedDb` service via
 * {@link IndexedDbCacheStoreOptions.indexedDb} — e.g. built from
 * `fake-indexeddb` in tests.
 */

import { Effect, Layer, Scope } from "effect";
import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { KeyValueStoreAdapter } from "@thomasfosterau/effect-sync-core";
import type { CacheStore } from "@thomasfosterau/effect-sync-core";

/**
 * Options for {@link make} / {@link layer}.
 */
export interface IndexedDbCacheStoreOptions {
  /** Database name. Default: `"effect-sync-cache"`. */
  readonly databaseName?: string | undefined;
  /**
   * Explicit IndexedDB primitives. Defaults to `window.indexedDB` via
   * `IndexedDb.layerWindow`; required in environments without a `window`
   * (e.g. tests using `fake-indexeddb`).
   */
  readonly indexedDb?: IndexedDb.IndexedDb | undefined;
}

const DEFAULT_DATABASE = "effect-sync-cache";

/**
 * The `IndexedDb` service layer: an explicitly provided implementation, or
 * the browser window's.
 */
const indexedDbLayer = (options?: IndexedDbCacheStoreOptions): Layer.Layer<IndexedDb.IndexedDb> =>
  options?.indexedDb !== undefined
    ? Layer.succeed(IndexedDb.IndexedDb, options.indexedDb)
    : IndexedDb.layerWindow;

/**
 * The platform-browser IndexedDB-backed `KeyValueStore` for the configured
 * database.
 */
const keyValueStoreLayer = (options?: IndexedDbCacheStoreOptions) =>
  BrowserKeyValueStore.layerIndexedDb({
    database: options?.databaseName ?? DEFAULT_DATABASE,
  }).pipe(Layer.provide(indexedDbLayer(options)));

/**
 * Construct an IndexedDB-backed `CacheStore` as a scoped resource: the
 * database connection stays open until the surrounding `Scope` closes.
 *
 * Subsequent `make` calls against the same `databaseName` see the same
 * persisted data. Dies if IndexedDB is unavailable in the environment (and
 * no explicit `indexedDb` implementation was provided).
 *
 * Most applications should prefer {@link layer}, which ties the connection
 * lifetime to the layer.
 */
export const make = (
  options?: IndexedDbCacheStoreOptions
): Effect.Effect<CacheStore, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithScope(keyValueStoreLayer(options), scope);
    return yield* Effect.provide(KeyValueStoreAdapter.make, context);
  });

/**
 * A layer providing core's `CacheStore` service backed by IndexedDB. The
 * database connection is open while the layer is alive.
 */
export const layer = (options?: IndexedDbCacheStoreOptions): Layer.Layer<CacheStore> =>
  KeyValueStoreAdapter.layer.pipe(Layer.provide(keyValueStoreLayer(options)));
