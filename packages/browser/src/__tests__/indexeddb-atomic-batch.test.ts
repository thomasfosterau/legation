/**
 * The IndexedDB atomic batch (#393): a pull and a push acknowledgement commit
 * as one IndexedDB transaction on the database and object store the platform
 * KeyValueStore uses. Backed by fake-indexeddb, whose transactions abort like
 * the browser's, so an abort here is a real one.
 */
import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { ClientStore } from "@thomasfosterau/legation-effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";

/**
 * Makes the Nth `put` of an armed batch throw, as a write that fails mid-transaction would. Every
 * readwrite transaction the factory opens is wrapped, so the batch's writes go through the wrapper;
 * nothing is armed outside a test that arms it.
 */
const failure = { armed: false, puts: 0, failAt: 2 };

const wrapStore = (store: IDBObjectStore): IDBObjectStore =>
  new Proxy(store, {
    get(target, prop) {
      if (prop === "put") {
        return (value: unknown) => {
          if (failure.armed && ++failure.puts === failure.failAt) {
            throw new DOMException("simulated write failure", "DataError");
          }
          return target.put(value as never);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const wrapTransaction = (tx: IDBTransaction): IDBTransaction =>
  new Proxy(tx, {
    get(target, prop) {
      if (prop === "objectStore") {
        return (name: string) => wrapStore(target.objectStore(name));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const wrapDatabase = (db: IDBDatabase): IDBDatabase =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return (names: string | string[], mode?: IDBTransactionMode) => {
          const tx = target.transaction(names, mode);
          return mode === "readwrite" ? wrapTransaction(tx) : tx;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const wrapRequest = (request: IDBOpenDBRequest): IDBOpenDBRequest =>
  new Proxy(request, {
    get(target, prop) {
      if (prop === "result") return wrapDatabase(target.result);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const failingIndexedDb: IDBFactory = new Proxy(indexedDB, {
  get(target, prop) {
    if (prop === "open") {
      return (name: string, version?: number) => wrapRequest(target.open(name, version));
    }
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const fakeIndexedDb = (factory: IDBFactory) =>
  Layer.succeed(IndexedDb.IndexedDb)(IndexedDb.make({ indexedDB: factory, IDBKeyRange }));

/** The store over `database`, as the browser composes it. */
const storeLayer = (database: string, factory: IDBFactory = indexedDB) =>
  IndexedDbClientStore.layer({ database }).pipe(Layer.provide(fakeIndexedDb(factory)));

/** The platform's own KeyValueStore over `database`: the raw view of the same records. */
const platformLayer = (database: string) =>
  BrowserKeyValueStore.layerIndexedDb({ database }).pipe(Layer.provide(fakeIndexedDb(indexedDB)));

const put = (id: string, n: number) =>
  ({
    _tag: "Put" as const,
    collection: "counters",
    id,
    version: 1,
    value: { id, n },
  }) as const;

const rowKey = (id: string) => `legation/row/counters/${id}`;
const RECORD = "legation/releaseIntent";

describe("IndexedDbClientStore's atomic batch (#393)", () => {
  it.effect(
    "the browser store commits a pull as one batch that the platform store reads back",
    () =>
      Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        expect(store.commitPull).toBeDefined();
        const kv = yield* KeyValueStore.KeyValueStore;

        yield* store.commitPull!({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [put("a", 1), put("b", 2)],
        });

        // The rows, the id index and the cookie sit in the platform's own records, and no record was written.
        expect(JSON.parse((yield* kv.get(rowKey("a"))) ?? "null")).toMatchObject({
          value: { n: 1 },
        });
        expect(yield* kv.get("legation/rowIndex/counters")).toBe('["a","b"]');
        expect(yield* kv.get("legation/cookie")).toBe("cookie-1");
        expect(yield* kv.has(RECORD)).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(storeLayer("atomic-readback"), platformLayer("atomic-readback"))
        )
      )
  );

  it.effect(
    "an aborted IndexedDB batch leaves the store at its pre-pull state, and a restart keeps the tail",
    () =>
      Effect.gen(function* () {
        const database = "atomic-abort";
        // The journal entry is parked before the pull, so the restart has a tail to show.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          const m1 = yield* store.appendNext({
            clientId: "c",
            mutator: "counter/inc",
            args: {},
            createdAt: 0,
          });
          yield* store.commitAcknowledgement!([m1], { c: 1 });
          yield* store.putRow("counters", { id: "a", version: 1, value: { id: "a", n: 0 } });
        }).pipe(Effect.provide(storeLayer(database)));

        // The pull's second row write fails mid-transaction: IndexedDB aborts the batch.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          failure.armed = true;
          failure.puts = 0;
          const pull = yield* Effect.exit(
            store.commitPull!({
              lastMutationIds: { c: 1 },
              cookie: "cookie-2",
              patch: [put("a", 5), put("b", 6)],
            })
          );
          failure.armed = false;
          expect(Exit.isFailure(pull)).toBe(true);
          // The first row write of the batch was rolled back with the rest.
          expect(yield* store.getRow("counters", "a")).toMatchObject({ value: { id: "a", n: 0 } });
          expect(yield* store.getRow("counters", "b")).toBeUndefined();
          expect(yield* store.getCookie).toBeUndefined();
        }).pipe(Effect.provide(storeLayer(database, failingIndexedDb)));

        // A restart shows the tail still parked, so the overlay keeps the acknowledged effect.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          expect((yield* store.unpulled).map((m) => `${m.clientId}#${m.mutationId}`)).toEqual([
            "c#1",
          ]);
          expect(yield* store.pendingMutations).toEqual([]);
          expect(yield* store.getCookie).toBeUndefined();
        }).pipe(Effect.provide(storeLayer(database)));
      })
  );

  it.effect(
    "a database written by the record path settles on open, including a leftover release record",
    () =>
      Effect.gen(function* () {
        const database = "atomic-legacy";
        // The current release's path, with no batch in context: the record is written and never finished,
        // as a crash would leave it.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.makeKeyValue();
          const m1 = yield* store.appendNext({
            clientId: "c",
            mutator: "counter/inc",
            args: {},
            createdAt: 0,
          });
          yield* store.parkUnpulled([m1]);
          yield* store.beginRelease({
            lastMutationIds: { c: 1 },
            cookie: "cookie-legacy",
            patch: [put("a", 7)],
          });
        }).pipe(Effect.provide(platformLayer(database)));

        // The batch-backed store opens the same database and settles the record.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          expect(store.commitPull).toBeDefined();
          expect(yield* store.getRow("counters", "a")).toMatchObject({ value: { id: "a", n: 7 } });
          expect(yield* store.getCookie).toBe("cookie-legacy");
          expect(yield* store.unpulled).toEqual([]);
          expect(yield* store.pendingMutations).toEqual([]);
          const kv = yield* KeyValueStore.KeyValueStore;
          expect(yield* kv.has(RECORD)).toBe(false);
        }).pipe(Effect.provide(Layer.mergeAll(storeLayer(database), platformLayer(database))));
      })
  );
});
