import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";
import * as Protocol from "../Protocol.js";
import * as ServerStore from "../ServerStore.js";
import * as Sessions from "../Sessions.js";
import * as SyncHub from "../SyncHub.js";
import * as Transport from "../Transport.js";

const hubLayer = () =>
  SyncHub.layer.pipe(Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer)));

// Collect the next `n` server messages a client receives.
const collectClient = (client: Transport.ClientTransport, n: number) =>
  Effect.forkChild(Stream.runCollect(Stream.take(client.messages, n)));

const settle = Effect.sleep(Duration.millis(20));

// Narrow a server message to a specific tag, asserting unconditionally so
// downstream assertions are not "conditional".
const asTag = <T extends Protocol.ServerMessage["_tag"]>(
  message: Protocol.ServerMessage | undefined,
  tag: T
): Extract<Protocol.ServerMessage, { readonly _tag: T }> => {
  expect(message?._tag).toBe(tag);
  return message as Extract<Protocol.ServerMessage, { readonly _tag: T }>;
};

const asPushResult = <T extends Protocol.PushResult["_tag"]>(
  result: Protocol.PushResult | undefined,
  tag: T
): Extract<Protocol.PushResult, { readonly _tag: T }> => {
  expect(result?._tag).toBe(tag);
  return result as Extract<Protocol.PushResult, { readonly _tag: T }>;
};

describe("SyncHub", () => {
  it.live("fans out an applied push to other subscribers but not the pusher", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const a = yield* Transport.makeInMemoryPair;
      const b = yield* Transport.makeInMemoryPair;

      const hubA = yield* Effect.forkChild(hub.handleConnection(a.server));
      const hubB = yield* Effect.forkChild(hub.handleConnection(b.server));

      // Both subscribe to the same prefix.
      yield* a.client.send(
        Protocol.ClientMessage.Subscribe({ id: "a-sub", filter: Protocol.prefixFilter(["users"]) })
      );
      yield* b.client.send(
        Protocol.ClientMessage.Subscribe({ id: "b-sub", filter: Protocol.prefixFilter(["users"]) })
      );
      yield* settle;

      // A expects only its own SubscribeAck + PushAck (no fan-out).
      const aFiber = yield* collectClient(a.client, 2);
      // B expects its SubscribeAck + the Updated fan-out.
      const bFiber = yield* collectClient(b.client, 2);

      yield* a.client.send(
        Protocol.ClientMessage.Push({
          id: "a-push",
          mutations: [{ mutationId: "m1", key: ["users", "1"], input: { name: "Ada" } }],
        })
      );

      const aMessages = yield* Fiber.join(aFiber);
      const bMessages = yield* Fiber.join(bFiber);

      yield* Fiber.interrupt(hubA);
      yield* Fiber.interrupt(hubB);

      expect(aMessages.map((m) => m._tag)).toEqual(["SubscribeAck", "PushAck"]);
      const pushAck = asTag(
        aMessages.find((m) => m._tag === "PushAck"),
        "PushAck"
      );
      expect(pushAck.results[0]?._tag).toBe("Applied");

      // B saw the fan-out Updated but no PushAck.
      const bTags = bMessages.map((m) => m._tag);
      expect(bTags).toContain("Updated");
      expect(bTags).not.toContain("PushAck");
      const updated = asTag(
        bMessages.find((m) => m._tag === "Updated"),
        "Updated"
      );
      expect(updated.entry.value).toEqual({ name: "Ada" });
      expect(updated.entry.version).toBe(1);
    }).pipe(Effect.provide(hubLayer()))
  );

  it.live("reports a Conflict for a push with a stale baseVersion", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const a = yield* Transport.makeInMemoryPair;
      const hubA = yield* Effect.forkChild(hub.handleConnection(a.server));
      yield* settle;

      // Seed the server with version 1 via a server-initiated publish.
      yield* hub.publish(["docs", "1"], { text: "v1" });

      const ackFiber = yield* collectClient(a.client, 1);
      // Client pushes with a stale base version (0).
      yield* a.client.send(
        Protocol.ClientMessage.Push({
          id: "push-stale",
          mutations: [
            { mutationId: "m1", key: ["docs", "1"], input: { text: "v2" }, baseVersion: 0 },
          ],
        })
      );

      const messages = yield* Fiber.join(ackFiber);
      yield* Fiber.interrupt(hubA);

      const ack = asTag(
        messages.find((m) => m._tag === "PushAck"),
        "PushAck"
      );
      const conflict = asPushResult(ack.results[0], "Conflict");
      expect(conflict.serverEntry.version).toBe(1);
      expect(conflict.serverEntry.value).toEqual({ text: "v1" });
    }).pipe(Effect.provide(hubLayer()))
  );

  it.live("returns current entries for a Pull and skips missing keys", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const a = yield* Transport.makeInMemoryPair;
      const hubA = yield* Effect.forkChild(hub.handleConnection(a.server));
      yield* settle;

      yield* hub.publish(["users", "1"], { name: "Ada" });
      yield* hub.publish(["users", "2"], { name: "Grace" });

      const fiber = yield* collectClient(a.client, 1);
      yield* a.client.send(
        Protocol.ClientMessage.Pull({
          id: "pull-1",
          keys: [
            ["users", "1"],
            ["users", "missing"],
            ["users", "2"],
          ],
        })
      );

      const messages = yield* Fiber.join(fiber);
      yield* Fiber.interrupt(hubA);

      const ack = asTag(
        messages.find((m) => m._tag === "PullAck"),
        "PullAck"
      );
      expect(ack.entries).toHaveLength(2);
      expect(ack.entries.map((e) => e.value)).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    }).pipe(Effect.provide(hubLayer()))
  );

  it.live("replies Pong to a Ping", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const a = yield* Transport.makeInMemoryPair;
      const hubA = yield* Effect.forkChild(hub.handleConnection(a.server));
      yield* settle;

      const fiber = yield* collectClient(a.client, 1);
      yield* a.client.send(Protocol.ClientMessage.Ping({ id: "ping-1" }));

      const messages = yield* Fiber.join(fiber);
      yield* Fiber.interrupt(hubA);

      const pong = asTag(messages[0], "Pong");
      expect(pong.id).toBe("ping-1");
    }).pipe(Effect.provide(hubLayer()))
  );

  it.live("publish() fans out only to sessions subscribed to a matching prefix", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const subscribed = yield* Transport.makeInMemoryPair;
      const other = yield* Transport.makeInMemoryPair;
      const hub1 = yield* Effect.forkChild(hub.handleConnection(subscribed.server));
      const hub2 = yield* Effect.forkChild(hub.handleConnection(other.server));

      // One subscribes to ["users"], the other to ["orders"].
      yield* subscribed.client.send(
        Protocol.ClientMessage.Subscribe({ id: "s1", filter: Protocol.prefixFilter(["users"]) })
      );
      yield* other.client.send(
        Protocol.ClientMessage.Subscribe({ id: "s2", filter: Protocol.prefixFilter(["orders"]) })
      );
      yield* settle;

      // Expect SubscribeAck + Updated on the matching client.
      const matchFiber = yield* collectClient(subscribed.client, 2);
      // The non-matching client should only ever see its SubscribeAck.
      const otherFiber = yield* collectClient(other.client, 1);

      yield* hub.publish(["users", "7"], { name: "Lin" });

      const matchMessages = yield* Fiber.join(matchFiber);
      const otherMessages = yield* Fiber.join(otherFiber);

      yield* Fiber.interrupt(hub1);
      yield* Fiber.interrupt(hub2);

      expect(matchMessages.map((m) => m._tag)).toEqual(["SubscribeAck", "Updated"]);
      // The other client only received its own ack, no fan-out.
      expect(otherMessages.map((m) => m._tag)).toEqual(["SubscribeAck"]);
    }).pipe(Effect.provide(hubLayer()))
  );

  it.live("tracks connected session count and cleans up on disconnect", () =>
    Effect.gen(function* () {
      const hub = yield* SyncHub.SyncHub;
      const a = yield* Transport.makeInMemoryPair;
      const b = yield* Transport.makeInMemoryPair;

      const hubA = yield* Effect.forkChild(hub.handleConnection(a.server));
      const hubB = yield* Effect.forkChild(hub.handleConnection(b.server));
      yield* settle;
      const both = yield* hub.connectedSessions;

      // Closing the connection shuts its message queue down, which ends
      // the handler fiber and runs its `ensuring` cleanup (unregister).
      yield* a.server.close;
      yield* Fiber.interrupt(hubA);
      yield* settle;
      const afterClose = yield* hub.connectedSessions;

      yield* Fiber.interrupt(hubB);

      expect(both).toBe(2);
      expect(afterClose).toBe(1);
    }).pipe(Effect.provide(hubLayer()))
  );
});
