/**
 * Ledger stores (#468): the in-memory default and the key/value store adapter.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { KeyValueStore } from "effect/persistence";
import { BackendError } from "@thomasfosterau/legation-effect";
import * as Ledger from "../Ledger.js";

const group: Ledger.GroupLedger = {
  lastMutationIds: { "client-1": 3, "client-2": 1 },
  rejections: [{ clientId: "client-1", mutationId: 2, reason: "title taken" }],
};

describe("Ledger.memory", () => {
  it.effect("reads an empty group and persists nothing", () =>
    Effect.gen(function* () {
      expect(yield* Ledger.memory.read("g")).toEqual(Ledger.emptyGroup);
      yield* Ledger.memory.write("g", group);
      expect(yield* Ledger.memory.read("g")).toEqual(Ledger.emptyGroup);
    })
  );
});

describe("Ledger.keyValue", () => {
  it.effect("reads an unknown group as empty", () =>
    Effect.gen(function* () {
      const store = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      expect(yield* store.read("never-written")).toEqual(Ledger.emptyGroup);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("round-trips a group, keeping each group under its own key", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = Ledger.keyValue(kv);
      yield* store.write("g", group);
      expect(yield* store.read("g")).toEqual(group);
      expect(yield* store.read("other")).toEqual(Ledger.emptyGroup);
      expect(yield* kv.has("legation-jsonapi:ledger:g")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("refuses a stored value that does not decode, rather than reading it as empty", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      yield* kv.set("legation-jsonapi:ledger:g", "{not json");
      const store = Ledger.keyValue(kv);
      const notJson = yield* Effect.flip(store.read("g"));
      expect(notJson).toBeInstanceOf(BackendError);
      yield* kv.set("legation-jsonapi:ledger:g", JSON.stringify({ lastMutationIds: { a: "x" } }));
      const notLedger = yield* Effect.flip(store.read("g"));
      expect(notLedger).toBeInstanceOf(BackendError);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});
