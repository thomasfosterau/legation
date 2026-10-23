/**
 * The IndexedDB atomic batch (#393): a pull and a push acknowledgement commit
 * as one IndexedDB transaction on the database and object store the platform
 * KeyValueStore uses. Backed by fake-indexeddb, whose transactions abort like
 * the browser's, so an abort here is a real one.
 */
import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { ClientStore, Hydration } from "@thomasfosterau/legation-effect";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import { KeyValueStore } from "effect/persistence";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";
import { defined } from "./defined.js";

/**
 * Makes the Nth `put` of an armed batch throw, as a write that fails mid-transaction would. Every
 * readwrite transaction the factory opens is wrapped, so the batch's writes go through the wrapper;
 * nothing is armed outside a test that arms it.
 */
const failure = { armed: false, puts: 0, failAt: 2 };

/** What the proxied factory saw: each readwrite and readonly transaction opened, and each key a put wrote. */
const tally = { readwrite: 0, readonly: 0, putKeys: [] as Array<string> };

/** A property read a trap does not intercept: the target's own, with methods bound to it. */
const passThrough = <T extends object>(target: T, prop: string | symbol): T[keyof T] => {
  const value = target[prop as keyof T];
  return P.isFunction(value) ? value.bind(target) : value;
};

const wrapStore = (store: IDBObjectStore): IDBObjectStore =>
  new Proxy(store, {
    get(target, prop) {
      if (prop === "put") {
        return (value: unknown) => {
          if (failure.armed && ++failure.puts === failure.failAt) {
            throw new DOMException("simulated write failure", "DataError");
          }
          const key = (value as { key?: unknown } | undefined)?.key;
          if (P.isString(key)) tally.putKeys.push(key);
          return target.put(value as never);
        };
      }
      return passThrough(target, prop);
    },
  });

const wrapTransaction = (tx: IDBTransaction): IDBTransaction =>
  new Proxy(tx, {
    get(target, prop) {
      if (prop === "objectStore") {
        return (name: string) => wrapStore(target.objectStore(name));
      }
      return passThrough(target, prop);
    },
  });

const wrapDatabase = (db: IDBDatabase): IDBDatabase =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return (names: string | string[], mode?: IDBTransactionMode) => {
          const tx = target.transaction(names, mode);
          if (mode === "readonly") tally.readonly += 1;
          if (mode !== "readwrite") return tx;
          tally.readwrite += 1;
          return wrapTransaction(tx);
        };
      }
      return passThrough(target, prop);
    },
  });

const wrapRequest = (request: IDBOpenDBRequest): IDBOpenDBRequest =>
  new Proxy(request, {
    get(target, prop) {
      if (prop === "result") return wrapDatabase(target.result);
      return passThrough(target, prop);
    },
  });

const failingIndexedDb: IDBFactory = new Proxy(indexedDB, {
  get(target, prop) {
    if (prop === "open") {
      return (name: string, version?: number) => wrapRequest(target.open(name, version));
    }
    return passThrough(target, prop);
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

/** Writes `record` into the entries store of `database` as IndexedDB holds it, whatever its value's type. */
const putRawRecord = (
  database: string,
  record: { readonly key: string; readonly value: unknown }
) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.addEventListener("success", () => {
      const db = request.result;
      const tx = db.transaction("entries", "readwrite");
      tx.objectStore("entries").put(record);
      tx.addEventListener("complete", () => {
        db.close();
        resolve();
      });
      tx.addEventListener("error", () => reject(tx.error));
    });
    request.addEventListener("error", () => reject(request.error));
  });

/** Creates `database` at version 2, with the entries store when `withEntries`, as a later version would. */
const createAtVersion2 = (database: string, withEntries: boolean) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(database, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(withEntries ? "entries" : "other", { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });

/** The version `database` is at, read by opening it without one. */
const versionOf = (database: string) =>
  new Promise<number>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
    request.onerror = () => reject(request.error);
  });

/** Asks for `database` at `version`, resolving "upgraded", or "blocked" when an open connection holds it. */
const upgradeTo = (database: string, version: number) =>
  new Promise<"upgraded" | "blocked">((resolve, reject) => {
    const request = indexedDB.open(database, version);
    request.onblocked = () => resolve("blocked");
    request.onsuccess = () => {
      request.result.close();
      resolve("upgraded");
    };
    request.onerror = () => reject(request.error);
  });

describe("IndexedDbClientStore's atomic batch (#393)", () => {
  it.effect(
    "the browser store commits a pull as one batch that the platform store reads back",
    () =>
      Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        expect(store.commitPull).toBeDefined();
        const kv = yield* KeyValueStore.KeyValueStore;

        yield* defined(store.commitPull)({
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
          yield* defined(store.commitAcknowledgement)([m1], { c: 1 });
          yield* store.putRow("counters", { id: "a", version: 1, value: { id: "a", n: 0 } });
        }).pipe(Effect.provide(storeLayer(database)));

        // The pull's second row write fails mid-transaction: IndexedDB aborts the batch.
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          failure.armed = true;
          failure.puts = 0;
          const pull = yield* Effect.exit(
            defined(store.commitPull)({
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

  it.effect("a durable pull is one readwrite transaction, and writes each key once", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-0",
          patch: [put("a", 0)],
        });
      }).pipe(Effect.provide(storeLayer("atomic-tally")));

      tally.readwrite = 0;
      tally.putKeys.length = 0;
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        // Row a is patched twice: one put for it, as the staged batch holds one value per key.
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [put("a", 1), put("b", 2), put("a", 3)],
        });
      }).pipe(Effect.provide(storeLayer("atomic-tally", failingIndexedDb)));

      expect(tally.readwrite).toBe(1);
      expect(tally.putKeys).toContain(rowKey("a"));
      expect(tally.putKeys).toHaveLength(new Set(tally.putKeys).size);
      expect(tally.putKeys.filter((key) => key === rowKey("a"))).toHaveLength(1);
    })
  );

  it.effect("the store builds and commits over a database a later version created at v2", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => createAtVersion2("atomic-v2", true));
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-v2",
          patch: [put("a", 3)],
        });
        expect(yield* store.getRow("counters", "a")).toMatchObject({ value: { n: 3 } });
        expect(yield* store.getCookie).toBe("cookie-v2");
      }).pipe(Effect.provide(storeLayer("atomic-v2")));
      // The store opened the database at the version it had: nothing was downgraded or upgraded.
      expect(yield* Effect.promise(() => versionOf("atomic-v2"))).toBe(2);
    })
  );

  it.effect(
    "a database without the entries store builds the layer, and its calls name the store",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => createAtVersion2("atomic-no-entries", false));
        yield* Effect.gen(function* () {
          // The layer builds. The store then seals at open, since its first read of the release record
          // has no entries store to read. The sealed message names the missing store itself, not only
          // its cause, so the reason is not lost behind the generic wording.
          const store = yield* ClientStore.ClientStore;
          const error = yield* store.getCookie.pipe(Effect.flip);
          expect(error.message).toContain('has no "entries" object store');
          expect(error.message).not.toContain(
            "identity boundary could not be established on open,"
          );
          expect(String(error)).toContain('has no "entries" object store');
        }).pipe(Effect.provide(storeLayer("atomic-no-entries")));
      })
  );

  it.effect("an open connection yields to a later version, so the upgrade is not blocked", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        // The layer holds its connections open for the scope.
        yield* ClientStore.ClientStore;
        const outcome = yield* Effect.promise(() => upgradeTo("atomic-upgrade", 2));
        expect(outcome).toBe("upgraded");
      }).pipe(Effect.provide(storeLayer("atomic-upgrade")));
    })
  );

  it.effect(
    "a store whose database another connection upgraded fails each later call with a reload message",
    () =>
      Effect.gen(function* () {
        const database = "atomic-upgraded";
        yield* Effect.gen(function* () {
          const store = yield* ClientStore.ClientStore;
          yield* store.setCookie("cookie-before");
          // Another connection asks for a newer version. The store's connections close themselves,
          // and nothing reopens them, so every call from here on fails with the reload message.
          expect(yield* Effect.promise(() => upgradeTo(database, 2))).toBe("upgraded");

          const read = yield* Effect.exit(store.getCookie);
          const write = yield* Effect.exit(store.setCookie("cookie-after"));
          const batch = yield* Effect.exit(
            defined(store.commitPull)({
              lastMutationIds: {},
              cookie: "cookie-after",
              patch: [put("a", 1)],
            })
          );
          const attempts: ReadonlyArray<Exit.Exit<unknown, unknown>> = [read, write, batch];
          for (const attempt of attempts) {
            expect(Exit.isFailure(attempt)).toBe(true);
            expect(String(attempt)).toContain(
              "the IndexedDB database was upgraded by another connection; reload to continue"
            );
          }
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

  it.effect("a snapshot is one readonly transaction, and reads every part of the replica", () =>
    Effect.gen(function* () {
      const database = "atomic-snapshot";
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [put("a", 1)],
        });
        // One entry parked in the tail by an acknowledgement, one still in the journal.
        const first = yield* store.appendNext({
          clientId: "c",
          mutator: "counter/inc",
          args: {},
          createdAt: 0,
        });
        yield* defined(store.commitAcknowledgement)([first], { c: first.mutationId });
        yield* store.appendNext({ clientId: "c", mutator: "counter/inc", args: {}, createdAt: 0 });
      }).pipe(Effect.provide(storeLayer(database)));

      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        tally.readonly = 0;
        tally.readwrite = 0;
        const state = yield* defined(store.snapshot);
        // The whole read is one transaction, and it writes nothing.
        expect(tally.readonly).toBe(1);
        expect(tally.readwrite).toBe(0);
        expect(state.rows.map((entry) => entry.row.id)).toEqual(["a"]);
        expect(state.cookie).toBe("cookie-1");
        expect(state.journal.map((m) => m.mutationId)).toEqual([2]);
        expect(state.unpulled.map((m) => m.mutationId)).toEqual([1]);

        // Dehydrate takes the same single read, so the snapshot it returns is the same state.
        tally.readonly = 0;
        const snapshot = yield* Hydration.dehydrate(store);
        expect(tally.readonly).toBe(1);
        expect(snapshot.journal.map((m) => m.mutationId)).toEqual([2]);
        expect(snapshot.unpulled?.map((m) => m.mutationId)).toEqual([1]);
      }).pipe(Effect.provide(storeLayer(database, failingIndexedDb)));
    })
  );

  it.effect("a snapshot skips a non-string record, as the member reads do", () =>
    Effect.gen(function* () {
      const database = "atomic-snapshot-non-string";
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* defined(store.commitPull)({
          lastMutationIds: {},
          cookie: "cookie-1",
          patch: [put("a", 1)],
        });
      }).pipe(Effect.provide(storeLayer(database)));
      // A number where the cookie belongs: IndexedDB stores it, the platform store reads it as absent.
      yield* Effect.promise(() => putRawRecord(database, { key: "legation/cookie", value: 7 }));

      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        const state = yield* defined(store.snapshot);
        expect(state.cookie).toBeUndefined();
        expect(state.cookie).toBe(yield* store.getCookie);
        expect(state.rows.map((entry) => entry.row)).toEqual(yield* store.listRows("counters"));
        expect(state.journal).toEqual(yield* store.pendingMutations);
        expect(state.unpulled).toEqual(yield* store.unpulled);
      }).pipe(Effect.provide(storeLayer(database)));
    })
  );
});
