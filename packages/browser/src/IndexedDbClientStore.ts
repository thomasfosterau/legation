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
 * Which to choose: namespace when the device has a small number of regular
 * users who switch back and forth (each keeps a warm replica, so switching
 * back costs no re-pull, at the price of holding both on disk); reset when
 * sign-ins are one-off or unbounded — a kiosk, a shared library machine —
 * where accumulating a replica per visitor is the worse trade.
 */

import { IndexedDb } from "@effect/platform-browser";
import { ClientStore, Identity, StoreError } from "@thomasfosterau/legation-effect";
import { AtomicKeyValue } from "@thomasfosterau/legation-effect/internal";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";

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
 * The database and object store this module reads and writes: the database
 * platform-browser's `BrowserKeyValueStore.layerIndexedDb` (4.0.2) also uses,
 * by default `effect_key_value_store`, with an `entries` store keyed by `key`
 * whose records are `{ key, value }`. Both are written here in the same layout,
 * so the store and the atomic batch read one database.
 *
 * The database is opened without a version (#393). The platform's layer opens
 * at version 1, which fails with a `VersionError` on a database a later version
 * created, and that failure kills the layer. Opening at whatever version exists
 * keeps the layer alive. A database without the `entries` store cannot be fixed
 * from here (creating it needs a version upgrade), so its reads and its batch
 * fail with an error that names it.
 */
const PLATFORM_DATABASE = "effect_key_value_store";
const ENTRIES_STORE = "entries";

/**
 * Open the platform's database at the version it has, creating the entries
 * store only when the database is new. The connection closes itself when
 * another connection asks for a newer version, rather than blocking that
 * connection's upgrade (`onversionchange`).
 */
const openDatabase = (
  database: string
): Effect.Effect<IDBDatabase, StoreError, IndexedDb.IndexedDb> =>
  Effect.gen(function* () {
    const idb = (yield* IndexedDb.IndexedDb).indexedDB;
    return yield* Effect.callback<IDBDatabase, StoreError>((resume) => {
      const fail = (cause: unknown) =>
        resume(
          Effect.fail(new StoreError({ message: "Failed to open the IndexedDB store", cause }))
        );
      let request: IDBOpenDBRequest;
      try {
        request = idb.open(database);
      } catch (cause) {
        fail(cause);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          db.createObjectStore(ENTRIES_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resume(Effect.succeed(db));
      };
      request.onerror = () => fail(request.error);
    });
  });

/** A clear error for a database that lacks the entries store (see the module note above). */
const missingEntriesStore = (db: IDBDatabase, method: string, key?: string) =>
  new KeyValueStore.KeyValueStoreError({
    method,
    message: `IndexedDB database "${db.name}" has no "${ENTRIES_STORE}" object store`,
    ...(key === undefined ? {} : { key }),
  });

/**
 * One request in its own transaction, resolved when the transaction completes,
 * so a write is durable before the caller continues. A failed or aborted
 * transaction fails the call.
 */
const runRequest = <A>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  failure: { readonly method: string; readonly message: string; readonly key?: string },
  evaluate: (store: IDBObjectStore) => IDBRequest<A>
): Effect.Effect<A, KeyValueStore.KeyValueStoreError> =>
  Effect.callback<A, KeyValueStore.KeyValueStoreError>((resume) => {
    let settled = false;
    let result: A | undefined;
    const finish = (effect: Effect.Effect<A, KeyValueStore.KeyValueStoreError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const fail = (cause: unknown) =>
      finish(Effect.fail(new KeyValueStore.KeyValueStoreError({ ...failure, cause })));
    if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
      finish(Effect.fail(missingEntriesStore(db, failure.method, failure.key)));
      return;
    }
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(ENTRIES_STORE, mode);
    } catch (cause) {
      fail(cause);
      return;
    }
    transaction.oncomplete = () => finish(Effect.succeed(result as A));
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    try {
      const request = evaluate(transaction.objectStore(ENTRIES_STORE));
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => fail(request.error);
    } catch (cause) {
      fail(cause);
      try {
        transaction.abort();
      } catch {
        // Already finished: nothing left to abort.
      }
    }
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      try {
        transaction.abort();
      } catch {
        // Already finished: nothing left to abort.
      }
    });
  });

/**
 * The platform's `KeyValueStore` semantics over the database {@link openDatabase}
 * opened: a string value reads back as a string, a `Uint8Array` as bytes, and
 * every call is its own transaction, as the platform's store makes them.
 */
const keyValueOver = (db: IDBDatabase): KeyValueStore.KeyValueStore => {
  /** A stored record: the `{ key, value }` the platform writes. */
  type StoredRecord = { readonly key: string; readonly value: unknown } | undefined;
  return KeyValueStore.make({
    get: (key) =>
      runRequest<StoredRecord>(
        db,
        "readonly",
        { method: "get", message: "Failed to get value from backing store", key },
        (store) => store.get(key)
      ).pipe(Effect.map((found) => (typeof found?.value === "string" ? found.value : undefined))),
    getUint8Array: (key) =>
      runRequest<StoredRecord>(
        db,
        "readonly",
        { method: "getUint8Array", message: "Failed to get value from backing store", key },
        (store) => store.get(key)
      ).pipe(Effect.map((found) => (found?.value instanceof Uint8Array ? found.value : undefined))),
    has: (key) =>
      runRequest(
        db,
        "readonly",
        { method: "has", message: "Failed to check key in backing store", key },
        (store) => store.count(key)
      ).pipe(Effect.map((count) => count > 0)),
    set: (key, value) =>
      runRequest(
        db,
        "readwrite",
        { method: "set", message: "Failed to set value in backing store", key },
        (store) => store.put({ key, value })
      ).pipe(Effect.asVoid),
    remove: (key) =>
      runRequest(
        db,
        "readwrite",
        { method: "remove", message: "Failed to remove value from backing store", key },
        (store) => store.delete(key)
      ).pipe(Effect.asVoid),
    clear: runRequest(
      db,
      "readwrite",
      { method: "clear", message: "Failed to clear backing store" },
      (store) => store.clear()
    ).pipe(Effect.asVoid),
    size: runRequest(
      db,
      "readonly",
      { method: "size", message: "Failed to get backing store size" },
      (store) => store.count()
    ),
  });
};

/**
 * Commit `ops` in one `readwrite` transaction on the entries store: IndexedDB
 * commits a transaction whole or not at all, so a failed or interrupted batch
 * leaves the store as it was.
 */
const commitOps = (
  db: IDBDatabase,
  ops: ReadonlyArray<AtomicKeyValue.KeyValueOp>
): Effect.Effect<void, StoreError> =>
  Effect.callback<void, StoreError>((resume) => {
    let settled = false;
    const finish = (effect: Effect.Effect<void, StoreError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const fail = (cause: unknown) =>
      finish(
        Effect.fail(
          new StoreError({ message: "Failed to commit an atomic batch to IndexedDB", cause })
        )
      );
    if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
      finish(
        Effect.fail(
          new StoreError({
            message: `Cannot commit an atomic batch: IndexedDB database "${db.name}" has no "${ENTRIES_STORE}" object store`,
          })
        )
      );
      return;
    }
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(ENTRIES_STORE, "readwrite");
    } catch (cause) {
      fail(cause);
      return;
    }
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // Already finished: nothing left to abort.
      }
    };
    transaction.oncomplete = () => finish(Effect.void);
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    try {
      const entries = transaction.objectStore(ENTRIES_STORE);
      // Every request is issued synchronously here: IndexedDB commits a transaction once control
      // returns to the event loop with no request pending, so nothing may await between them.
      for (const op of ops) {
        if (op._tag === "Set") entries.put({ key: op.key, value: op.value });
        else entries.delete(op.key);
      }
    } catch (cause) {
      fail(cause);
      abort();
    }
    // Interrupted before the commit point: abort, so none of the batch lands.
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        abort();
      }
    });
  });

/**
 * The platform `KeyValueStore` over IndexedDB, opened without a version (see
 * the module note above). Keys are the full keys the store holds.
 */
const keyValueLayer = (
  database: string | undefined
): Layer.Layer<KeyValueStore.KeyValueStore, never, IndexedDb.IndexedDb> =>
  Layer.effect(KeyValueStore.KeyValueStore)(
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        openDatabase(database ?? PLATFORM_DATABASE),
        (opened) => Effect.sync(() => opened.close())
      ).pipe(Effect.orDie);
      return keyValueOver(db);
    })
  );

/**
 * The atomic batch over the same IndexedDB database as the `KeyValueStore`
 * (#393). Keys arrive in full, namespace prefix included, as the store holds
 * them, so the batch needs no knowledge of the prefix.
 */
const atomicKeyValueLayer = (
  database: string | undefined
): Layer.Layer<AtomicKeyValue.AtomicKeyValue, never, IndexedDb.IndexedDb> =>
  Layer.effect(AtomicKeyValue.AtomicKeyValue)(
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        openDatabase(database ?? PLATFORM_DATABASE),
        (opened) => Effect.sync(() => opened.close())
      ).pipe(Effect.orDie);
      return AtomicKeyValue.AtomicKeyValue.of({
        apply: (ops) => (ops.length === 0 ? Effect.void : commitOps(db, ops)),
      });
    })
  );

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
