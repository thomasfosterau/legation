import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import {
  MemoryCacheStore,
  Outbox,
  Protocol,
  SyncCache,
  Transport,
} from "@thomasfosterau/effect-sync-core";
import { QueryClient, SyncClient } from "@thomasfosterau/effect-sync-client";

// SyncCache + Outbox + QueryClient all share one CacheStore.
const baseLayer = Layer.mergeAll(SyncCache.layer, Outbox.layer, QueryClient.layer).pipe(
  Layer.provideMerge(MemoryCacheStore.layer())
);

describe("SyncClient", () => {
  it("mutateLocal applies the mutation and enqueues to the outbox", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;
            const cache = yield* SyncCache.SyncCache;

            const value = yield* client.mutateLocal(
              {
                key: ["todos", "create"],
                execute: (input: { title: string }) => Effect.succeed({ id: "1", ...input }),
                updates: (_input, res) => [{ key: ["todos", "1"], value: res }],
              },
              { title: "Buy milk" }
            );

            const size = yield* outbox.size;
            const peeked = yield* cache.peek<{ id: string; title: string }>(["todos", "1"]);
            return { value, size, cached: Option.getOrUndefined(peeked)?.value };
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<{
        value: { id: string; title: string };
        size: number;
        cached: { id: string; title: string } | undefined;
      }>
    );
    expect(result.value).toEqual({ id: "1", title: "Buy milk" });
    expect(result.size).toBe(1);
    expect(result.cached).toEqual({ id: "1", title: "Buy milk" });
  });

  it("push drains the outbox and sends a Push message", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          // Capture client->server messages on the server side.
          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(pair.server.messages, (message) =>
              Ref.update(seen, (msgs) => [...msgs, message])
            )
          );

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;

            yield* client.mutateLocal(
              {
                key: ["todos", "create"],
                execute: (input: { title: string }) => Effect.succeed({ id: "1", ...input }),
              },
              { title: "Buy milk" }
            );
            const before = yield* outbox.size;

            yield* client.push;
            yield* Effect.sleep(Duration.millis(20));
            const after = yield* outbox.size;
            const messages = yield* Ref.get(seen);
            return { before, after, messages };
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<{
        before: number;
        after: number;
        messages: ReadonlyArray<Protocol.ClientMessage>;
      }>
    );
    expect(result.before).toBe(1);
    expect(result.after).toBe(0);
    const push = result.messages.find((m) => m._tag === "Push");
    expect(push?._tag).toBe("Push");
    expect(push?._tag === "Push" && push.mutations[0]?.key).toEqual(["todos", "create"]);
  });

  it("runSync pushes the outbox when the connection comes up", async () => {
    const remaining = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          // Drain server messages so the transport queue does not fill up.
          yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;

            yield* client.mutateLocal(
              { key: ["todos", "create"], execute: (i: unknown) => Effect.succeed(i) },
              { title: "x" }
            );

            yield* Effect.forkScoped(client.runSync);
            // Toggle to connected to trigger a push.
            yield* pair.setStatus("disconnected");
            yield* pair.setStatus("connected");
            yield* Effect.sleep(Duration.millis(50));

            return yield* outbox.size;
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<number>
    );
    expect(remaining).toBe(0);
  });
});
