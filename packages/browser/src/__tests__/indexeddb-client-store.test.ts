/**
 * IndexedDB ClientStore tests: the browser composition (core KeyValueStore
 * store over platform-browser's IndexedDB KVS) persists and rehydrates,
 * backed by fake-indexeddb.
 */
import { IndexedDb } from "@effect/platform-browser";
import { ClientStore } from "@legation/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";

const fakeIndexedDb = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB, IDBKeyRange })
);

const storeLayer = (database: string) =>
  IndexedDbClientStore.layer({ database }).pipe(Layer.provide(fakeIndexedDb));

describe("IndexedDbClientStore", () => {
  it.effect("persists rows, journal, and cookie across store rebuilds", () =>
    Effect.gen(function* () {
      // First "service worker lifetime": write state.
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* store.putRow("todos", { id: "1", version: 3, value: { title: "indexed" } });
        yield* store.appendMutation({
          clientId: "c1",
          mutationId: yield* store.nextMutationId("c1"),
          mutator: "todo/set",
          args: { id: "1" },
          createdAt: 0,
        });
        yield* store.setCookie("cvr-1");
      }).pipe(Effect.provide(storeLayer("sw-lifetime")));

      // Second lifetime over the same database: everything rehydrates.
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        const row = yield* store.getRow("todos", "1");
        expect(row?.version).toBe(3);
        expect(row?.value).toEqual({ title: "indexed" });
        expect(yield* store.pendingMutations).toHaveLength(1);
        expect(yield* store.getCookie).toBe("cvr-1");
        expect(yield* store.nextMutationId("c1")).toBe(2);
      }).pipe(Effect.provide(storeLayer("sw-lifetime")));
    })
  );

  it.effect("databases are isolated", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* store.putRow("todos", { id: "1", version: 1, value: {} });
      }).pipe(Effect.provide(storeLayer("db-a")));

      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        expect(yield* store.listRows("todos")).toEqual([]);
      }).pipe(Effect.provide(storeLayer("db-b")));
    })
  );
});
