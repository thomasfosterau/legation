import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as ServerStore from "../ServerStore.js";
import * as SyncKey from "../SyncKey.js";

describe("ServerStore", () => {
  it.effect("increments version on each set, starting at 1", () =>
    Effect.gen(function* () {
      const store = yield* ServerStore.ServerStore;
      const v1 = yield* store.set(["users", "1"], { name: "a" });
      const v2 = yield* store.set(["users", "1"], { name: "b" });
      const v3 = yield* store.set(["users", "1"], { name: "c" });
      expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(ServerStore.memoryLayer))
  );

  it.effect("get returns the latest stored entry, none for missing keys", () =>
    Effect.gen(function* () {
      const store = yield* ServerStore.ServerStore;
      yield* store.set(["k"], 1);
      yield* store.set(["k"], 2);
      const present = yield* store.get(["k"]);
      const absent = yield* store.get(["nope"]);

      expect(Option.getOrUndefined(present)?.value).toBe(2);
      expect(Option.getOrUndefined(present)?.version).toBe(2);
      expect(Option.isNone(absent)).toBe(true);
    }).pipe(Effect.provide(ServerStore.memoryLayer))
  );

  it.effect("remove returns the removed entry and clears the key", () =>
    Effect.gen(function* () {
      const store = yield* ServerStore.ServerStore;
      yield* store.set(["x"], "value");
      const removed = yield* store.remove(["x"]);
      const after = yield* store.get(["x"]);
      const removeMissing = yield* store.remove(["x"]);

      expect(Option.getOrUndefined(removed)?.value).toBe("value");
      expect(Option.isNone(after)).toBe(true);
      expect(Option.isNone(removeMissing)).toBe(true);
    }).pipe(Effect.provide(ServerStore.memoryLayer))
  );

  it.effect("list filters entries by prefix", () =>
    Effect.gen(function* () {
      const store = yield* ServerStore.ServerStore;
      yield* store.set(["users", "1"], "a");
      yield* store.set(["users", "2"], "b");
      yield* store.set(["orders", "1"], "c");
      const all = yield* store.list();
      const users = yield* store.list(SyncKey.prefixFilter(["users"]));

      expect(all.length).toBe(3);
      expect(users.map((e) => e.key)).toHaveLength(2);
    }).pipe(Effect.provide(ServerStore.memoryLayer))
  );
});
