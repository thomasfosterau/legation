import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Outbox from "../Outbox.js";
import * as Protocol from "../Protocol.js";
import * as SyncCache from "../SyncCache.js";
import * as Transport from "../Transport.js";
import * as QueryClient from "../QueryClient.js";
import * as SyncClient from "../SyncClient.js";

// SyncCache + Outbox + QueryClient all share one CacheStore.
const baseLayer = Layer.mergeAll(SyncCache.layer, Outbox.layer, QueryClient.layer).pipe(
  Layer.provideMerge(MemoryCacheStore.layer())
);

// Capture client->server messages on the server side into `seen`.
const collectServerMessages = (
  pair: Transport.InMemoryPair,
  seen: Ref.Ref<ReadonlyArray<Protocol.ClientMessage>>
) =>
  Effect.asVoid(
    Effect.forkScoped(
      Stream.runForEach(pair.server.messages, (message) =>
        Ref.update(seen, (msgs) => [...msgs, message])
      )
    )
  );

describe("SyncClient", () => {
  it("mutateLocal applies the mutation and enqueues to the outbox", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
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

  it("push sends a Push message and entries remain in the outbox until PushAck", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* collectServerMessages(pair, seen);

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
            // No PushAck has arrived, so the entry must still be queued.
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
    expect(result.after).toBe(1);
    const push = result.messages.find((m) => m._tag === "Push");
    expect(push?._tag).toBe("Push");
    expect(push?._tag === "Push" && push.mutations[0]?.key).toEqual(["todos", "create"]);
  });

  it("PushAck Applied discards the entry and writes the server entry into the cache", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* collectServerMessages(pair, seen);

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;
            const cache = yield* SyncCache.SyncCache;

            yield* Effect.forkScoped(client.runSync);

            const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
            yield* client.push;
            yield* Effect.sleep(Duration.millis(20));

            yield* pair.server.send({
              _tag: "PushAck",
              id: "ignored",
              results: [
                {
                  _tag: "Applied",
                  mutationId: entry.id,
                  entry: {
                    key: ["todos", "1"],
                    value: { title: "server" },
                    version: 7,
                    updatedAt: 1,
                  },
                },
              ],
            });
            yield* Effect.sleep(Duration.millis(30));

            const size = yield* outbox.size;
            const peeked = yield* cache.peek<{ title: string }>(["todos", "1"]);
            return {
              size,
              cached: Option.getOrUndefined(peeked)?.value,
              version: Option.getOrUndefined(peeked)?.version,
            };
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<{
        size: number;
        cached: { title: string } | undefined;
        version: number | string | undefined;
      }>
    );
    expect(result.size).toBe(0);
    expect(result.cached).toEqual({ title: "server" });
    expect(result.version).toBe(7);
  });

  it("PushAck Conflict + preferRemote writes serverEntry and discards the entry", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer({ conflictStrategy: "preferRemote" }).pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;
            const cache = yield* SyncCache.SyncCache;

            yield* Effect.forkScoped(client.runSync);

            const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
            yield* client.push;
            yield* Effect.sleep(Duration.millis(20));

            yield* pair.server.send({
              _tag: "PushAck",
              id: "ignored",
              results: [
                {
                  _tag: "Conflict",
                  mutationId: entry.id,
                  key: ["todos", "1"],
                  serverEntry: {
                    key: ["todos", "1"],
                    value: { title: "remote-wins" },
                    version: 9,
                    updatedAt: 5,
                  },
                },
              ],
            });
            yield* Effect.sleep(Duration.millis(30));

            const size = yield* outbox.size;
            const peeked = yield* cache.peek<{ title: string }>(["todos", "1"]);
            return { size, cached: Option.getOrUndefined(peeked)?.value };
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<{
        size: number;
        cached: { title: string } | undefined;
      }>
    );
    expect(result.size).toBe(0);
    expect(result.cached).toEqual({ title: "remote-wins" });
  });

  it("PushAck Conflict + preferLocal re-pushes with baseVersion = server version", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer({ conflictStrategy: "preferLocal" }).pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* collectServerMessages(pair, seen);

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;

            yield* Effect.forkScoped(client.runSync);

            const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
            yield* client.push;
            yield* Effect.sleep(Duration.millis(20));

            yield* pair.server.send({
              _tag: "PushAck",
              id: "ignored",
              results: [
                {
                  _tag: "Conflict",
                  mutationId: entry.id,
                  key: ["todos", "1"],
                  serverEntry: {
                    key: ["todos", "1"],
                    value: { title: "remote" },
                    version: 42,
                    updatedAt: 5,
                  },
                },
              ],
            });
            yield* Effect.sleep(Duration.millis(30));

            return yield* Ref.get(seen);
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<ReadonlyArray<Protocol.ClientMessage>>
    );
    // The conflict drives a re-push carrying the server's version as the new
    // base version so the server applies the local value next time.
    const rePush = result.find(
      (m) => m._tag === "Push" && m.mutations.some((mut) => mut.baseVersion === 42)
    );
    expect(rePush?._tag).toBe("Push");
    expect(rePush?._tag === "Push" && rePush.mutations[0]?.baseVersion).toBe(42);
  });

  it("PushAck Rejected discards the entry", async () => {
    const remaining = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const outbox = yield* Outbox.Outbox;

            yield* Effect.forkScoped(client.runSync);

            const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
            yield* client.push;
            yield* Effect.sleep(Duration.millis(20));

            yield* pair.server.send({
              _tag: "PushAck",
              id: "ignored",
              results: [
                {
                  _tag: "Rejected",
                  mutationId: entry.id,
                  key: ["todos", "1"],
                  reason: "validation failed",
                },
              ],
            });
            yield* Effect.sleep(Duration.millis(30));

            return yield* outbox.size;
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<number>
    );
    expect(remaining).toBe(0);
  });

  it("resubscribes and pulls known keys on reconnect", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* collectServerMessages(pair, seen);

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;

            yield* Effect.forkScoped(client.runSync);
            yield* Effect.sleep(Duration.millis(10));

            // Subscribe (recorded) and learn a key via an Updated message.
            yield* client.subscribe(Protocol.exactFilter(["users", "1"]));
            yield* pair.server.send({
              _tag: "Updated",
              entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 0 },
            });
            yield* Effect.sleep(Duration.millis(20));

            // Drop the captured messages so we only see what reconnect re-sends.
            yield* Ref.set(seen, []);

            yield* pair.setStatus("disconnected");
            yield* pair.setStatus("connected");
            yield* Effect.sleep(Duration.millis(40));

            return yield* Ref.get(seen);
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<ReadonlyArray<Protocol.ClientMessage>>
    );
    const resubscribe = result.find((m) => m._tag === "Subscribe");
    expect(resubscribe?._tag === "Subscribe" && resubscribe.filter).toEqual(
      Protocol.exactFilter(["users", "1"])
    );
    const pull = result.find((m) => m._tag === "Pull");
    expect(pull?._tag === "Pull" && pull.keys).toEqual([["users", "1"]]);
  });

  it("PullAck entries are written into the cache", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;
            const cache = yield* SyncCache.SyncCache;

            yield* Effect.forkScoped(client.runSync);
            yield* Effect.sleep(Duration.millis(10));

            yield* pair.server.send({
              _tag: "PullAck",
              id: "pull-1",
              entries: [
                { key: ["users", "2"], value: { name: "Grace" }, version: 3, updatedAt: 9 },
              ],
            });
            yield* Effect.sleep(Duration.millis(30));

            const peeked = yield* cache.peek<{ name: string }>(["users", "2"]);
            return {
              cached: Option.getOrUndefined(peeked)?.value,
              version: Option.getOrUndefined(peeked)?.version,
            };
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<{
        cached: { name: string } | undefined;
        version: number | string | undefined;
      }>
    );
    expect(result.cached).toEqual({ name: "Grace" });
    expect(result.version).toBe(3);
  });

  it("runSync pushes the outbox when the connection comes up", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pair = yield* Transport.makeInMemoryPair;
          const layer = SyncClient.layer().pipe(
            Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
          );

          const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
          yield* collectServerMessages(pair, seen);

          return yield* Effect.gen(function* () {
            const client = yield* SyncClient.SyncClient;

            yield* client.mutateLocal(
              { key: ["todos", "create"], execute: (i: unknown) => Effect.succeed(i) },
              { title: "x" }
            );

            yield* Effect.forkScoped(client.runSync);
            yield* pair.setStatus("disconnected");
            yield* pair.setStatus("connected");
            yield* Effect.sleep(Duration.millis(50));

            // Entry stays queued (no ack), but a Push must have been sent.
            const messages = yield* Ref.get(seen);
            return messages.filter((m) => m._tag === "Push").length;
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(baseLayer)) as Effect.Effect<number>
    );
    expect(result).toBeGreaterThanOrEqual(1);
  });
});
