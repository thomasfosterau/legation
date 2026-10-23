/**
 * The platform-compatible IndexedDB key-value seam under {@link IndexedDbClientStore} (#393). Not part of
 * the package's public surface: the store and the tests import it from here, and nothing re-exports it.
 *
 * It opens the platform's database without a version, keeps one connection per layer, and gives the
 * store a `KeyValueStore` whose records the platform's `BrowserKeyValueStore` reads back, plus the
 * `AtomicKeyValue` batch over the same entries store.
 */

import { IndexedDb } from "@effect/platform-browser";
import { StoreError } from "@thomasfosterau/legation-effect";
import { AtomicKeyValue } from "@thomasfosterau/legation-effect/internal";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import { KeyValueStore } from "effect/persistence";

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
 * What every call on a store whose database another connection upgraded fails with (#393). The
 * connection is closed by then, so the call cannot run; the message says why.
 */
const UPGRADED_MESSAGE =
  "the IndexedDB database was upgraded by another connection; reload to continue";

/** One open connection to the platform database, and whether another connection has closed it. */
interface Connection {
  readonly db: IDBDatabase;
  /** Set when another connection asks for a newer version and this one closes itself. */
  upgraded: boolean;
}

/**
 * Open the platform's database at the version it has, creating the entries
 * store only when the database is new. The connection closes itself when
 * another connection asks for a newer version, rather than blocking that
 * connection's upgrade (`onversionchange`); after that, its calls fail with
 * {@link UPGRADED_MESSAGE}.
 */
const openDatabase = (
  database: string
): Effect.Effect<Connection, StoreError, IndexedDb.IndexedDb> =>
  Effect.gen(function* () {
    const idb = (yield* IndexedDb.IndexedDb).indexedDB;
    return yield* Effect.callback<Connection, StoreError>((resume) => {
      const fail = (cause: unknown) =>
        resume(
          Effect.fail(new StoreError({ message: "Failed to open the IndexedDB store", cause }))
        );
      const opened = Result.try(() => idb.open(database));
      if (Result.isFailure(opened)) {
        fail(opened.failure);
        return;
      }
      const request = opened.success;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          db.createObjectStore(ENTRIES_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const connection: Connection = { db: request.result, upgraded: false };
        connection.db.onversionchange = () => {
          connection.upgraded = true;
          connection.db.close();
        };
        resume(Effect.succeed(connection));
      };
      request.onerror = () => fail(request.error);
    });
  });

/**
 * Abort `transaction`, ignoring the `InvalidStateError` an already-finished
 * transaction throws: there is nothing left to abort then.
 */
const abortQuietly = (transaction: IDBTransaction): void => {
  Result.try(() => transaction.abort());
};

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
  connection: Connection,
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
      finish(
        Effect.fail(
          new KeyValueStore.KeyValueStoreError({
            ...failure,
            message: connection.upgraded ? UPGRADED_MESSAGE : failure.message,
            cause,
          })
        )
      );
    if (connection.upgraded) {
      finish(
        Effect.fail(
          new KeyValueStore.KeyValueStoreError({
            method: failure.method,
            message: UPGRADED_MESSAGE,
            ...(failure.key === undefined ? {} : { key: failure.key }),
          })
        )
      );
      return;
    }
    const db = connection.db;
    if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
      finish(Effect.fail(missingEntriesStore(db, failure.method, failure.key)));
      return;
    }
    const began = Result.try(() => db.transaction(ENTRIES_STORE, mode));
    if (Result.isFailure(began)) {
      fail(began.failure);
      return;
    }
    const transaction = began.success;
    transaction.oncomplete = () => finish(Effect.succeed(result as A));
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    const issued = Result.try(() => {
      const request = evaluate(transaction.objectStore(ENTRIES_STORE));
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => fail(request.error);
    });
    if (Result.isFailure(issued)) {
      fail(issued.failure);
      abortQuietly(transaction);
    }
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      abortQuietly(transaction);
    });
  });

/**
 * The platform's `KeyValueStore` semantics over the database {@link openDatabase}
 * opened: a string value reads back as a string, a `Uint8Array` as bytes, and
 * every call is its own transaction, as the platform's store makes them.
 */
const keyValueOver = (connection: Connection): KeyValueStore.KeyValueStore => {
  /** A stored record: the `{ key, value }` the platform writes. */
  type StoredRecord = { readonly key: string; readonly value: unknown } | undefined;
  return KeyValueStore.make({
    get: (key) =>
      runRequest<StoredRecord>(
        connection,
        "readonly",
        { method: "get", message: "Failed to get value from backing store", key },
        (store) => store.get(key)
      ).pipe(Effect.map((found) => (P.isString(found?.value) ? found.value : undefined))),
    getUint8Array: (key) =>
      runRequest<StoredRecord>(
        connection,
        "readonly",
        { method: "getUint8Array", message: "Failed to get value from backing store", key },
        (store) => store.get(key)
      ).pipe(Effect.map((found) => (found?.value instanceof Uint8Array ? found.value : undefined))),
    has: (key) =>
      runRequest(
        connection,
        "readonly",
        { method: "has", message: "Failed to check key in backing store", key },
        (store) => store.count(key)
      ).pipe(Effect.map((count) => count > 0)),
    set: (key, value) =>
      runRequest(
        connection,
        "readwrite",
        { method: "set", message: "Failed to set value in backing store", key },
        (store) => store.put({ key, value })
      ).pipe(Effect.asVoid),
    remove: (key) =>
      runRequest(
        connection,
        "readwrite",
        { method: "remove", message: "Failed to remove value from backing store", key },
        (store) => store.delete(key)
      ).pipe(Effect.asVoid),
    clear: runRequest(
      connection,
      "readwrite",
      { method: "clear", message: "Failed to clear backing store" },
      (store) => store.clear()
    ).pipe(Effect.asVoid),
    size: runRequest(
      connection,
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
  connection: Connection,
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
          new StoreError({
            message: connection.upgraded
              ? UPGRADED_MESSAGE
              : "Failed to commit an atomic batch to IndexedDB",
            cause,
          })
        )
      );
    if (connection.upgraded) {
      finish(Effect.fail(new StoreError({ message: UPGRADED_MESSAGE })));
      return;
    }
    const db = connection.db;
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
    const began = Result.try(() => db.transaction(ENTRIES_STORE, "readwrite"));
    if (Result.isFailure(began)) {
      fail(began.failure);
      return;
    }
    const transaction = began.success;
    const abort = () => abortQuietly(transaction);
    transaction.oncomplete = () => finish(Effect.void);
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    const issued = Result.try(() => {
      const entries = transaction.objectStore(ENTRIES_STORE);
      // Every request is issued synchronously here: IndexedDB commits a transaction once control
      // returns to the event loop with no request pending, so nothing may await between them.
      for (const op of ops) {
        if (op._tag === "Set") entries.put({ key: op.key, value: op.value });
        else entries.delete(op.key);
      }
    });
    if (Result.isFailure(issued)) {
      fail(issued.failure);
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
export const keyValueLayer = (
  database: string | undefined
): Layer.Layer<KeyValueStore.KeyValueStore, never, IndexedDb.IndexedDb> =>
  Layer.effect(KeyValueStore.KeyValueStore)(
    Effect.gen(function* () {
      const connection = yield* Effect.acquireRelease(
        openDatabase(database ?? PLATFORM_DATABASE),
        (opened) => Effect.sync(() => opened.db.close())
      ).pipe(Effect.orDie);
      return keyValueOver(connection);
    })
  );

/**
 * Every string entry in the entries store, read in one `readonly` transaction (#392): a single
 * request, so the records are one state of the database and a batch another connection commits is
 * either wholly in them or wholly absent. The platform store writes only strings for the keys this
 * layer reads, so other values are left out.
 */
const readEntries = (
  connection: Connection
): Effect.Effect<ReadonlyArray<AtomicKeyValue.KeyValueEntry>, StoreError> =>
  runRequest<Array<{ readonly key: string; readonly value: unknown }>>(
    connection,
    "readonly",
    { method: "getAll", message: "Failed to read the IndexedDB store" },
    (store) => store.getAll()
  ).pipe(
    Effect.map((records) =>
      records.flatMap((record) =>
        P.isString(record.value) ? [{ key: record.key, value: record.value }] : []
      )
    ),
    Effect.mapError((error) => new StoreError({ message: error.message, cause: error }))
  );

/**
 * The atomic batch over the same IndexedDB database as the `KeyValueStore`
 * (#393), with its one-transaction read of the entries (#392). Keys arrive in
 * full, namespace prefix included, as the store holds them, so the batch needs
 * no knowledge of the prefix.
 */
export const atomicKeyValueLayer = (
  database: string | undefined
): Layer.Layer<AtomicKeyValue.AtomicKeyValue, never, IndexedDb.IndexedDb> =>
  Layer.effect(AtomicKeyValue.AtomicKeyValue)(
    Effect.gen(function* () {
      const connection = yield* Effect.acquireRelease(
        openDatabase(database ?? PLATFORM_DATABASE),
        (opened) => Effect.sync(() => opened.db.close())
      ).pipe(Effect.orDie);
      return AtomicKeyValue.AtomicKeyValue.of({
        apply: (ops) => (Arr.isReadonlyArrayEmpty(ops) ? Effect.void : commitOps(connection, ops)),
        readAll: readEntries(connection),
      });
    })
  );
