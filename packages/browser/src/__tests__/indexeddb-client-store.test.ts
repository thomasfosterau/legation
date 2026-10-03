/**
 * IndexedDB ClientStore tests: the browser composition (core KeyValueStore
 * store over platform-browser's IndexedDB KVS) persists and rehydrates,
 * backed by fake-indexeddb.
 */
import { IndexedDb } from "@effect/platform-browser";
import { ClientStore, Identity } from "@thomasfosterau/legation-effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";

const fakeIndexedDb = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB, IDBKeyRange })
);

const storeLayer = (database: string) =>
  IndexedDbClientStore.layer({ database }).pipe(Layer.provide(fakeIndexedDb));

const scopedLayer = (database: string, identity: Identity.Fingerprint) =>
  IndexedDbClientStore.layer({ database, identity }).pipe(Layer.provide(fakeIndexedDb));

/** `layerNamespaced`'s composition, over the fake IndexedDB. */
const namespacedLayer = (database: string, identity: Identity.Fingerprint) =>
  IndexedDbClientStore.layer({
    database,
    identity,
    prefix: IndexedDbClientStore.namespacedPrefix(identity),
  }).pipe(Layer.provide(fakeIndexedDb));

const ALICE: Identity.Fingerprint = "sha256:alice";
const BOB: Identity.Fingerprint = "sha256:bob";

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

  // #212: a browser replica is a replica on a *device*, so this is the
  // shared-device case end to end — A's private rows written by one service
  // worker lifetime, B's lifetime opening the same IndexedDB database next.
  it.effect("an identity change across lifetimes does not serve the previous user's rows", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* store.putRow("todos", { id: "1", version: 1, value: { title: "alice's" } });
        yield* store.setCookie("cvr-alice");
        yield* store.appendMutation({
          clientId: "c1",
          mutationId: yield* store.nextMutationId("c1"),
          mutator: "todo/set",
          args: { id: "2" },
          createdAt: 0,
        });
      }).pipe(Effect.provide(scopedLayer("shared-device", ALICE)));

      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        expect(yield* store.listRows("todos")).toEqual([]);
        expect(yield* store.getCookie).toBeUndefined();
        expect(yield* store.pendingMutations).toEqual([]);
        // Held, not destroyed.
        expect(yield* store.quarantinedMutations(ALICE)).toHaveLength(1);
      }).pipe(Effect.provide(scopedLayer("shared-device", BOB)));
    })
  );

  it.effect("namespacing keeps a replica per identity instead of resetting either", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* store.putRow("todos", { id: "1", version: 1, value: { title: "alice's" } });
      }).pipe(Effect.provide(namespacedLayer("two-users", ALICE)));

      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        expect(yield* store.listRows("todos")).toEqual([]);
        yield* store.putRow("todos", { id: "2", version: 1, value: { title: "bob's" } });
      }).pipe(Effect.provide(namespacedLayer("two-users", BOB)));

      // A switches back to a replica still warm — nothing was reset, because
      // the two never shared a keyspace.
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        const rows = yield* store.listRows("todos");
        expect(rows.map((row) => (row.value as { title: string }).title)).toEqual(["alice's"]);
      }).pipe(Effect.provide(namespacedLayer("two-users", ALICE)));
    })
  );
});
