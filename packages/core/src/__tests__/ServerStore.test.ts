import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SyncKey from "../SyncKey.js";
import * as ServerStore from "../ServerStore.js";

const run = <A, E>(program: Effect.Effect<A, E, ServerStore.ServerStore>): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(ServerStore.ServerStore), () => program).pipe(
      Effect.provide(ServerStore.memoryLayer)
    ) as Effect.Effect<A, E>
  );

describe("ServerStore", () => {
  it("increments version on each set, starting at 1", async () => {
    const versions = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(ServerStore.ServerStore);
        const v1 = yield* store.set(["users", "1"], { name: "a" });
        const v2 = yield* store.set(["users", "1"], { name: "b" });
        const v3 = yield* store.set(["users", "1"], { name: "c" });
        return [v1.version, v2.version, v3.version];
      })
    );
    expect(versions).toEqual([1, 2, 3]);
  });

  it("get returns the latest stored entry, none for missing keys", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(ServerStore.ServerStore);
        yield* store.set(["k"], 1);
        yield* store.set(["k"], 2);
        const present = yield* store.get(["k"]);
        const absent = yield* store.get(["nope"]);
        return {
          value: Option.getOrUndefined(present)?.value,
          version: Option.getOrUndefined(present)?.version,
          absent: Option.isNone(absent),
        };
      })
    );
    expect(result.value).toBe(2);
    expect(result.version).toBe(2);
    expect(result.absent).toBe(true);
  });

  it("remove returns the removed entry and clears the key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(ServerStore.ServerStore);
        yield* store.set(["x"], "value");
        const removed = yield* store.remove(["x"]);
        const after = yield* store.get(["x"]);
        const removeMissing = yield* store.remove(["x"]);
        return {
          removedValue: Option.getOrUndefined(removed)?.value,
          gone: Option.isNone(after),
          removeMissingNone: Option.isNone(removeMissing),
        };
      })
    );
    expect(result.removedValue).toBe("value");
    expect(result.gone).toBe(true);
    expect(result.removeMissingNone).toBe(true);
  });

  it("list filters entries by prefix", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Effect.service(ServerStore.ServerStore);
        yield* store.set(["users", "1"], "a");
        yield* store.set(["users", "2"], "b");
        yield* store.set(["orders", "1"], "c");
        const all = yield* store.list();
        const users = yield* store.list(SyncKey.prefixFilter(["users"]));
        return { allCount: all.length, userKeys: users.map((e) => e.key) };
      })
    );
    expect(result.allCount).toBe(3);
    expect(result.userKeys).toHaveLength(2);
  });
});
