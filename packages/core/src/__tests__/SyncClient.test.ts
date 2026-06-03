import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import * as MemoryCacheStore from "../MemoryCacheStore.js";
import * as Outbox from "../Outbox.js";
import * as Protocol from "../Protocol.js";
import * as QueryClient from "../QueryClient.js";
import * as SyncCache from "../SyncCache.js";
import * as SyncClient from "../SyncClient.js";
import * as Transport from "../Transport.js";

// SyncCache + Outbox + QueryClient all share one CacheStore.
const baseLayer = () =>
  Layer.mergeAll(SyncCache.layer, Outbox.layer, QueryClient.layer).pipe(
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
  it.live("mutateLocal applies the mutation and enqueues to the outbox", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      yield* Effect.gen(function* () {
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

        expect(value).toEqual({ id: "1", title: "Buy milk" });
        expect(size).toBe(1);
        expect(Option.getOrUndefined(peeked)?.value).toEqual({ id: "1", title: "Buy milk" });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("push sends a Push message and entries remain in the outbox until PushAck", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
      yield* collectServerMessages(pair, seen);

      yield* Effect.gen(function* () {
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

        expect(before).toBe(1);
        expect(after).toBe(1);
        const push = messages.find((m) => m._tag === "Push");
        expect(push?._tag).toBe("Push");
        expect(push?._tag === "Push" && push.mutations[0]?.key).toEqual(["todos", "create"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("PushAck Applied discards the entry and writes the server entry into the cache", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
      yield* collectServerMessages(pair, seen);

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;
        const outbox = yield* Outbox.Outbox;
        const cache = yield* SyncCache.SyncCache;

        yield* Effect.forkScoped(client.runSync);

        const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
        yield* client.push;
        yield* Effect.sleep(Duration.millis(20));

        yield* pair.server.send(
          Protocol.ServerMessage.PushAck({
            id: "ignored",
            results: [
              Protocol.PushResult.Applied({
                mutationId: entry.id,
                entry: {
                  key: ["todos", "1"],
                  value: { title: "server" },
                  version: 7,
                  updatedAt: 1,
                },
              }),
            ],
          })
        );
        yield* Effect.sleep(Duration.millis(30));

        const size = yield* outbox.size;
        const peeked = yield* cache.peek<{ title: string }>(["todos", "1"]);

        expect(size).toBe(0);
        expect(Option.getOrUndefined(peeked)?.value).toEqual({ title: "server" });
        expect(Option.getOrUndefined(peeked)?.version).toBe(7);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("PushAck Conflict + preferRemote writes serverEntry and discards the entry", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer({ conflictStrategy: "preferRemote" }).pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;
        const outbox = yield* Outbox.Outbox;
        const cache = yield* SyncCache.SyncCache;

        yield* Effect.forkScoped(client.runSync);

        const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
        yield* client.push;
        yield* Effect.sleep(Duration.millis(20));

        yield* pair.server.send(
          Protocol.ServerMessage.PushAck({
            id: "ignored",
            results: [
              Protocol.PushResult.Conflict({
                mutationId: entry.id,
                key: ["todos", "1"],
                serverEntry: {
                  key: ["todos", "1"],
                  value: { title: "remote-wins" },
                  version: 9,
                  updatedAt: 5,
                },
              }),
            ],
          })
        );
        yield* Effect.sleep(Duration.millis(30));

        const size = yield* outbox.size;
        const peeked = yield* cache.peek<{ title: string }>(["todos", "1"]);

        expect(size).toBe(0);
        expect(Option.getOrUndefined(peeked)?.value).toEqual({ title: "remote-wins" });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("PushAck Conflict + preferLocal re-pushes with baseVersion = server version", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer({ conflictStrategy: "preferLocal" }).pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
      yield* collectServerMessages(pair, seen);

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;
        const outbox = yield* Outbox.Outbox;

        yield* Effect.forkScoped(client.runSync);

        const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
        yield* client.push;
        yield* Effect.sleep(Duration.millis(20));

        yield* pair.server.send(
          Protocol.ServerMessage.PushAck({
            id: "ignored",
            results: [
              Protocol.PushResult.Conflict({
                mutationId: entry.id,
                key: ["todos", "1"],
                serverEntry: {
                  key: ["todos", "1"],
                  value: { title: "remote" },
                  version: 42,
                  updatedAt: 5,
                },
              }),
            ],
          })
        );
        yield* Effect.sleep(Duration.millis(30));

        const messages = yield* Ref.get(seen);
        // The conflict drives a re-push carrying the server's version as the new
        // base version so the server applies the local value next time.
        const rePush = messages.find(
          (m) => m._tag === "Push" && m.mutations.some((mut) => mut.baseVersion === 42)
        );
        expect(rePush?._tag).toBe("Push");
        expect(rePush?._tag === "Push" && rePush.mutations[0]?.baseVersion).toBe(42);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("PushAck Rejected discards the entry", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;
        const outbox = yield* Outbox.Outbox;

        yield* Effect.forkScoped(client.runSync);

        const entry = yield* outbox.enqueue(["todos", "1"], { title: "local" });
        yield* client.push;
        yield* Effect.sleep(Duration.millis(20));

        yield* pair.server.send(
          Protocol.ServerMessage.PushAck({
            id: "ignored",
            results: [
              Protocol.PushResult.Rejected({
                mutationId: entry.id,
                key: ["todos", "1"],
                reason: "validation failed",
              }),
            ],
          })
        );
        yield* Effect.sleep(Duration.millis(30));

        const remaining = yield* outbox.size;
        expect(remaining).toBe(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("resubscribes and pulls known keys on reconnect", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
      yield* collectServerMessages(pair, seen);

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;

        yield* Effect.forkScoped(client.runSync);
        yield* Effect.sleep(Duration.millis(10));

        // Subscribe (recorded) and learn a key via an Updated message.
        yield* client.subscribe(Protocol.exactFilter(["users", "1"]));
        yield* pair.server.send(
          Protocol.ServerMessage.Updated({
            entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 0 },
          })
        );
        yield* Effect.sleep(Duration.millis(20));

        // Drop the captured messages so we only see what reconnect re-sends.
        yield* Ref.set(seen, []);

        yield* pair.setStatus("disconnected");
        yield* pair.setStatus("connected");
        yield* Effect.sleep(Duration.millis(40));

        const messages = yield* Ref.get(seen);
        const resubscribe = messages.find((m) => m._tag === "Subscribe");
        expect(resubscribe?._tag === "Subscribe" && resubscribe.filter).toEqual(
          Protocol.exactFilter(["users", "1"])
        );
        const pull = messages.find((m) => m._tag === "Pull");
        expect(pull?._tag === "Pull" && pull.keys).toEqual([["users", "1"]]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("PullAck entries are written into the cache", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      yield* Effect.forkScoped(Stream.runDrain(pair.server.messages));

      yield* Effect.gen(function* () {
        const client = yield* SyncClient.SyncClient;
        const cache = yield* SyncCache.SyncCache;

        yield* Effect.forkScoped(client.runSync);
        yield* Effect.sleep(Duration.millis(10));

        yield* pair.server.send(
          Protocol.ServerMessage.PullAck({
            id: "pull-1",
            entries: [{ key: ["users", "2"], value: { name: "Grace" }, version: 3, updatedAt: 9 }],
          })
        );
        yield* Effect.sleep(Duration.millis(30));

        const peeked = yield* cache.peek<{ name: string }>(["users", "2"]);

        expect(Option.getOrUndefined(peeked)?.value).toEqual({ name: "Grace" });
        expect(Option.getOrUndefined(peeked)?.version).toBe(3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );

  it.live("runSync pushes the outbox when the connection comes up", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;
      const layer = SyncClient.layer().pipe(
        Layer.provideMerge(Layer.succeed(Transport.ClientTransport, pair.client))
      );

      const seen = yield* Ref.make<ReadonlyArray<Protocol.ClientMessage>>([]);
      yield* collectServerMessages(pair, seen);

      yield* Effect.gen(function* () {
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
        expect(messages.filter((m) => m._tag === "Push").length).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(baseLayer()))
  );
});
