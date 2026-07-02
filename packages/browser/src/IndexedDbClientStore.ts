/**
 * IndexedDbClientStore
 *
 * The durable browser ClientStore (ADR-0010): core's KeyValueStore-backed
 * store over platform-browser's IndexedDB KeyValueStore. Every engine
 * state transition lands in IndexedDB, so a killed service worker (or
 * closed tab in main-thread hosting) rehydrates losslessly.
 */

import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { ClientStore } from "@legation/effect";
import { Layer } from "effect";

export interface IndexedDbClientStoreOptions {
  /** IndexedDB database name. Defaults to platform-browser's default. */
  readonly database?: string;
  /** Key namespace inside the store. Defaults to core's `"legation/"`. */
  readonly prefix?: string;
}

/**
 * ClientStore over IndexedDB. Requires the `IndexedDb` primitives service;
 * use {@link layerWindow} where browser globals are available, or provide
 * `IndexedDb` yourself (tests use fake-indexeddb).
 */
export const layer = (
  options?: IndexedDbClientStoreOptions
): Layer.Layer<ClientStore.ClientStore, never, IndexedDb.IndexedDb> =>
  ClientStore.layerKeyValue(options?.prefix === undefined ? {} : { prefix: options.prefix }).pipe(
    Layer.provide(
      BrowserKeyValueStore.layerIndexedDb(
        options?.database === undefined ? {} : { database: options.database }
      )
    )
  );

/** Self-contained layer using the browser's global `indexedDB`. */
export const layerWindow = (
  options?: IndexedDbClientStoreOptions
): Layer.Layer<ClientStore.ClientStore> =>
  layer(options).pipe(Layer.provide(IndexedDb.layerWindow));
