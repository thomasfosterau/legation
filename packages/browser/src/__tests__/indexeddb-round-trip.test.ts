/**
 * The IndexedDB store and the platform's own KeyValueStore read each other's records (#393): the
 * store's keys and value shapes are the platform's, so a host that reads either one sees the same
 * data. Backed by fake-indexeddb, as the other IndexedDB tests are.
 */
import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { ClientStore } from "@thomasfosterau/legation-effect";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyValueStore } from "effect/persistence";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import * as IndexedDbClientStore from "../IndexedDbClientStore.js";
import { keyValueLayer } from "../internal/IndexedDbKeyValue.js";

const fakeIndexedDb = Layer.succeed(IndexedDb.IndexedDb)(
  IndexedDb.make({ indexedDB, IDBKeyRange })
);

/** The new store's KeyValueStore over `database`. */
const newKeyValue = (database: string) =>
  keyValueLayer(database).pipe(Layer.provide(fakeIndexedDb));

/** The platform's KeyValueStore over `database`. */
const platformKeyValue = (database: string) =>
  BrowserKeyValueStore.layerIndexedDb({ database }).pipe(Layer.provide(fakeIndexedDb));

/** A ClientStore over `database`, as the browser composes it. */
const clientStore = (database: string) =>
  IndexedDbClientStore.layer({ database }).pipe(Layer.provide(fakeIndexedDb));

describe("IndexedDbClientStore round trips with the platform store (#393)", () => {
  it.effect(
    "the new key-value store and the platform's read each other's writes, removes and clears",
    () =>
      Effect.gen(function* () {
        const database = "round-trip-kv";
        const bytes = new Uint8Array([1, 2, 3]);

        // The new store writes a string and bytes, and removes a third key.
        yield* Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          yield* kv.set("rt/string", "hello");
          yield* kv.set("rt/bytes", bytes);
          yield* kv.set("rt/gone", "x");
          yield* kv.remove("rt/gone");
          expect(yield* kv.get("rt/string")).toBe("hello");
          expect(yield* kv.getUint8Array("rt/bytes")).toEqual(bytes);
          expect(yield* kv.has("rt/gone")).toBe(false);
          expect(yield* kv.size).toBe(2);
        }).pipe(Effect.provide(newKeyValue(database)));

        // The platform's store reads those back, writes one of its own, and removes one of theirs.
        yield* Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          expect(yield* kv.get("rt/string")).toBe("hello");
          expect(yield* kv.getUint8Array("rt/bytes")).toEqual(bytes);
          expect(yield* kv.has("rt/gone")).toBe(false);
          expect(yield* kv.size).toBe(2);
          yield* kv.set("rt/platform", "p");
          yield* kv.remove("rt/string");
        }).pipe(Effect.provide(platformKeyValue(database)));

        // The new store reads the platform's write, and its removal, then clears everything.
        yield* Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          expect(yield* kv.get("rt/platform")).toBe("p");
          expect(yield* kv.has("rt/string")).toBe(false);
          yield* kv.clear;
          expect(yield* kv.size).toBe(0);
        }).pipe(Effect.provide(newKeyValue(database)));

        // The clear is visible to the platform's store too.
        yield* Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          expect(yield* kv.size).toBe(0);
          expect(yield* kv.get("rt/platform")).toBeUndefined();
        }).pipe(Effect.provide(platformKeyValue(database)));
      })
  );

  it.effect("a ClientStore's row and cookie writes read back raw in the platform store", () =>
    Effect.gen(function* () {
      const database = "round-trip-store";
      yield* Effect.gen(function* () {
        const store = yield* ClientStore.ClientStore;
        yield* store.putRow("counters", { id: "a", version: 1, value: { id: "a", n: 5 } });
        yield* store.setCookie("cookie-rt2");
      }).pipe(Effect.provide(clientStore(database)));

      yield* Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        expect(JSON.parse((yield* kv.get("legation/row/counters/a")) ?? "null")).toEqual({
          id: "a",
          version: 1,
          value: { id: "a", n: 5 },
        });
        expect(yield* kv.get("legation/rowIndex/counters")).toBe('["a"]');
        expect(yield* kv.get("legation/cookie")).toBe("cookie-rt2");
      }).pipe(Effect.provide(platformKeyValue(database)));
    })
  );
});
