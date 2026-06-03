import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Protocol from "../Protocol.js";
import * as Subscriptions from "../Subscriptions.js";
import * as SyncCache from "../SyncCache.js";
import * as Transport from "../Transport.js";

const cacheLayer = () => SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()));

describe("Subscriptions", () => {
  it.live("applies server Updated messages to the cache", () =>
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
      yield* pair.server.send(
        Protocol.ServerMessage.Updated({
          entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 0 },
        })
      );
      yield* Effect.sleep(Duration.millis(30));

      const cached = yield* cache.peek<{ name: string }>(["users", "1"]);
      expect(Option.getOrUndefined(cached)?.value).toEqual({ name: "Ada" });
    }).pipe(Effect.provide(cacheLayer()))
  );

  it.live("removes entries on server Removed messages", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const cache = yield* SyncCache.SyncCache;
      yield* cache.set(["users", "1"], { name: "Ada" });

      yield* Effect.forkScoped(
        Subscriptions.runSubscriptions.pipe(
          Effect.provideService(Transport.ClientTransport, pair.client)
        )
      );

      yield* pair.server.send(Protocol.ServerMessage.Removed({ key: ["users", "1"], version: 2 }));
      yield* Effect.sleep(Duration.millis(30));

      const cached = yield* cache.peek(["users", "1"]);
      expect(Option.isNone(cached)).toBe(true);
    }).pipe(Effect.provide(cacheLayer()))
  );

  it.live("invalidates on server Invalidated messages", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const cache = yield* SyncCache.SyncCache;
      yield* cache.set(["users", "1"], { name: "Ada" }, { staleTime: Duration.minutes(5) });

      yield* Effect.forkScoped(
        Subscriptions.runSubscriptions.pipe(
          Effect.provideService(Transport.ClientTransport, pair.client)
        )
      );

      yield* pair.server.send(
        Protocol.ServerMessage.Invalidated({
          filter: Protocol.prefixFilter(["users"]),
        })
      );
      yield* Effect.sleep(Duration.millis(30));

      // After invalidation the entry should be stale (staleAt <= now).
      const entry = yield* cache.peek(["users", "1"]);
      const now = Date.now();
      const isStale = Option.match(entry, {
        onNone: () => false,
        onSome: (e) => e.staleAt !== null && e.staleAt <= now + 1,
      });
      expect(isStale).toBe(true);
    }).pipe(Effect.provide(cacheLayer()))
  );
});
