import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Protocol from "../Protocol.js";
import * as SyncCache from "../SyncCache.js";
import * as Transport from "../Transport.js";
import * as Subscriptions from "../Subscriptions.js";

const cacheLayer = SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("Subscriptions", () => {
  it("applies server Updated messages to the cache", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const cache = yield* SyncCache.SyncCache;

          // Run the subscription loop in the background.
          yield* Effect.forkScoped(
            Subscriptions.runSubscriptions.pipe(
              Effect.provideService(Transport.ClientTransport, pair.client)
            )
          );

          // Subscribe, then have the "server" push an Updated message.
          yield* Subscriptions.subscribeKeys(pair.client, Protocol.exactFilter(["users", "1"]));
          yield* pair.server.send({
            _tag: "Updated",
            entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 0 },
          });
          yield* Effect.sleep(Duration.millis(30));

          const cached = yield* cache.peek<{ name: string }>(["users", "1"]);
          return Option.getOrUndefined(cached)?.value;
        })
      ).pipe(Effect.provide(cacheLayer)) as Effect.Effect<{ name: string } | undefined>
    );
    expect(result).toEqual({ name: "Ada" });
  });

  it("removes entries on server Removed messages", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const cache = yield* SyncCache.SyncCache;
          yield* cache.set(["users", "1"], { name: "Ada" });

          yield* Effect.forkScoped(
            Subscriptions.runSubscriptions.pipe(
              Effect.provideService(Transport.ClientTransport, pair.client)
            )
          );

          yield* pair.server.send({ _tag: "Removed", key: ["users", "1"], version: 2 });
          yield* Effect.sleep(Duration.millis(30));

          const cached = yield* cache.peek(["users", "1"]);
          return Option.isNone(cached);
        })
      ).pipe(Effect.provide(cacheLayer)) as Effect.Effect<boolean>
    );
    expect(result).toBe(true);
  });

  it("invalidates on server Invalidated messages", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const cache = yield* SyncCache.SyncCache;
          yield* cache.set(["users", "1"], { name: "Ada" }, { staleTime: Duration.minutes(5) });

          yield* Effect.forkScoped(
            Subscriptions.runSubscriptions.pipe(
              Effect.provideService(Transport.ClientTransport, pair.client)
            )
          );

          yield* pair.server.send({
            _tag: "Invalidated",
            filter: Protocol.prefixFilter(["users"]),
          });
          yield* Effect.sleep(Duration.millis(30));

          // After invalidation the entry should be stale (staleAt <= now).
          const entry = yield* cache.peek(["users", "1"]);
          const now = Date.now();
          return Option.match(entry, {
            onNone: () => false,
            onSome: (e) => e.staleAt !== null && e.staleAt <= now + 1,
          });
        })
      ).pipe(Effect.provide(cacheLayer)) as Effect.Effect<boolean>
    );
    expect(result).toBe(true);
  });
});
