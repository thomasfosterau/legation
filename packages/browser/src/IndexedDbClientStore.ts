/**
 * IndexedDbClientStore
 *
 * The durable browser ClientStore (ADR-0010): core's KeyValueStore-backed
 * store over platform-browser's IndexedDB KeyValueStore. Every engine
 * state transition lands in IndexedDB, so a killed service worker (or
 * closed tab in main-thread hosting) rehydrates losslessly.
 *
 * A durable replica on a browser is a durable replica on a **device**, which
 * is where the identity boundary earns its keep (#212, CONTEXT.md): a
 * multi-tenant app on a shared device syncs one user's private rows
 * legitimately — the server's auth filter said they could have them — and
 * then the next user opens the app to the freshest thing on the machine.
 * There are two ways to hold that line, and both are here:
 *
 * - {@link layerWindow} with an `identity`: **one replica, reset on change.**
 *   The store stamps the fingerprint and compares it on open; a mismatch
 *   quarantines the unpushed journal under the superseded fingerprint and
 *   drops rows and cookie before anything can read them.
 * - {@link layerNamespaced}: **one replica per identity.** The fingerprint
 *   derives the key prefix, so two principals never share a keyspace and
 *   nothing needs resetting.
 *
 * A version change from another connection (a newer app build upgrading the
 * database, or a deletion) closes this store's connections, since they would
 * otherwise block it. From then on every call fails with an error that says
 * the database was upgraded by another connection and asks for a reload. The
 * store never reopens itself, so a reload is the way back.
 *
 * Which to choose: namespace when the device has a small number of regular
 * users who switch back and forth (each keeps a warm replica, so switching
 * back costs no re-pull, at the price of holding both on disk); reset when
 * sign-ins are one-off or unbounded — a kiosk, a shared library machine —
 * where accumulating a replica per visitor is the worse trade.
 */

import { IndexedDb } from "@effect/platform-browser";
import { ClientStore, Identity } from "@thomasfosterau/legation-effect";
import { Layer } from "effect";
import { atomicKeyValueLayer, keyValueLayer } from "./internal/IndexedDbKeyValue.js";

/** Options for the IndexedDB-backed `ClientStore` layers. */
export interface IndexedDbClientStoreOptions {
  /** IndexedDB database name. Defaults to platform-browser's default. */
  readonly database?: string;
  /** Key namespace inside the store. Defaults to core's `"legation/"`. */
  readonly prefix?: string;
  /**
   * The identity this replica belongs to — an opaque, app-supplied
   * fingerprint, **never PII and never a credential** (see
   * {@link Identity.Fingerprint}). Supplying it turns the identity boundary
   * on: the store compares it with its stamp on open and resets the replica
   * on a mismatch, quarantining unpushed writes under the superseded
   * fingerprint. Unset leaves the boundary off.
   */
  readonly identity?: Identity.Fingerprint;
}

/** The store options that reach core, absent keys left absent. */
const keyValueOptions = (
  options: IndexedDbClientStoreOptions | undefined
): ClientStore.KeyValueOptions => ({
  ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
  ...(options?.identity === undefined ? {} : { identity: options.identity }),
});

/**
 * ClientStore over IndexedDB. Requires the `IndexedDb` primitives service;
 * use {@link layerWindow} where browser globals are available, or provide
 * `IndexedDb` yourself (tests use fake-indexeddb).
 *
 * A pull and a push acknowledgement commit as one IndexedDB transaction (#393),
 * so a durable pull writes its rows once and writes no release record.
 */
export const layer = (
  options?: IndexedDbClientStoreOptions
): Layer.Layer<ClientStore.ClientStore, never, IndexedDb.IndexedDb> =>
  ClientStore.layerKeyValue(keyValueOptions(options)).pipe(
    Layer.provide(
      Layer.merge(keyValueLayer(options?.database), atomicKeyValueLayer(options?.database))
    )
  );

/** Self-contained layer using the browser's global `indexedDB`. */
export const layerWindow = (
  options?: IndexedDbClientStoreOptions
): Layer.Layer<ClientStore.ClientStore> =>
  layer(options).pipe(Layer.provide(IndexedDb.layerWindow));

/**
 * The key prefix {@link layerNamespaced} derives for a fingerprint:
 * core's `"legation/"` namespace with a percent-encoded identity segment
 * under it, so two principals' replicas cannot collide and neither can
 * collide with an un-namespaced one.
 */
export const namespacedPrefix = (identity: Identity.Fingerprint): string =>
  `legation/identity/${Identity.keySegment(identity)}/`;

/**
 * The namespacing alternative to resetting (#212): one replica per identity
 * in a single IndexedDB database, keyed by fingerprint.
 *
 * A principal's rows are unreachable from another principal's store because
 * they are under a different key prefix — no comparison, no reset, and a
 * user who switches back finds their replica still warm. The fingerprint is
 * still stamped, so a store reached through this layer keeps the same
 * guarantee if it is ever opened un-namespaced.
 *
 * The cost is disk: every identity that has ever signed in on this device
 * keeps a replica until something clears it. Prefer {@link layerWindow} with
 * an `identity` where sign-ins are unbounded.
 *
 * Pass `database` to isolate at the database level instead of the key level
 * — a heavier boundary (a whole IndexedDB database per identity, deletable
 * in one call) for apps that want it.
 */
export const layerNamespaced = (
  identity: Identity.Fingerprint,
  options?: Omit<IndexedDbClientStoreOptions, "identity" | "prefix">
): Layer.Layer<ClientStore.ClientStore> =>
  layerWindow({
    ...(options?.database === undefined ? {} : { database: options.database }),
    prefix: namespacedPrefix(identity),
    identity,
  });
