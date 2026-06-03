import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { Protocol, ServerStore, Sessions, SyncHub } from "@thomasfosterau/effect-sync-core";
import * as WebSocketServer from "../WebSocketServer.js";

const hubLayer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

// Open a browser-style WebSocket client (Node 22+ global) and resolve once
// the socket is open. Collected messages accumulate into `received`.
const openClient = (
  port: number
): Promise<{
  readonly socket: WebSocket;
  readonly received: Array<Protocol.ServerMessage>;
}> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: Array<Protocol.ServerMessage> = [];
    socket.addEventListener("message", (event) => {
      received.push(JSON.parse(event.data as string) as Protocol.ServerMessage);
    });
    socket.addEventListener("open", () => resolve({ socket, received }));
    socket.addEventListener("error", () => reject(new Error("client failed to connect")));
  });

const sendClient = (socket: WebSocket, message: Protocol.ClientMessage): void => {
  socket.send(JSON.stringify(message));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Narrow a server message to a specific tag, asserting unconditionally so
// downstream assertions are not "conditional".
const asTag = <T extends Protocol.ServerMessage["_tag"]>(
  message: Protocol.ServerMessage | undefined,
  tag: T
): Extract<Protocol.ServerMessage, { readonly _tag: T }> => {
  expect(message?._tag).toBe(tag);
  return message as Extract<Protocol.ServerMessage, { readonly _tag: T }>;
};

describe("WebSocketServer", () => {
  it.live("starts and reports a bound port", () =>
    Effect.gen(function* () {
      const server = yield* WebSocketServer.make({ port: 0 });
      const address = yield* server.address;
      expect(address.port).toBeGreaterThan(0);
    }).pipe(Effect.provide(hubLayer))
  );

  it.live(
    "answers a client Ping with a Pong end-to-end through the hub",
    () =>
      Effect.gen(function* () {
        const { port } = yield* WebSocketServer.serve({ port: 0 });
        const client = yield* Effect.promise(() => openClient(port));
        sendClient(client.socket, { _tag: "Ping", id: "ping-1" });
        yield* Effect.sleep(Duration.millis(50));
        client.socket.close();
        const received = client.received;
        expect(received.map((m) => m._tag)).toContain("Pong");
        const pong = asTag(
          received.find((m) => m._tag === "Pong"),
          "Pong"
        );
        expect(pong.id).toBe("ping-1");
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );

  it.live(
    "skips a malformed client frame and still answers a following valid Ping",
    () =>
      Effect.gen(function* () {
        const { port } = yield* WebSocketServer.serve({ port: 0 });
        const client = yield* Effect.promise(() => openClient(port));
        // Garbage that is not JSON, then JSON that is not a valid message, then
        // a valid Ping the server must still answer.
        client.socket.send("this is not json");
        client.socket.send(JSON.stringify({ nope: true }));
        sendClient(client.socket, { _tag: "Ping", id: "ping-after-garbage" });
        yield* Effect.sleep(Duration.millis(50));
        client.socket.close();
        const received = client.received;
        const pong = asTag(
          received.find((m) => m._tag === "Pong"),
          "Pong"
        );
        expect(pong.id).toBe("ping-after-garbage");
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );

  it.live(
    "fans out a Push from client A to a subscribed client B",
    () =>
      Effect.gen(function* () {
        const { port } = yield* WebSocketServer.serve({ port: 0 });
        const a = yield* Effect.promise(() => openClient(port));
        const b = yield* Effect.promise(() => openClient(port));

        sendClient(a.socket, {
          _tag: "Subscribe",
          id: "a-sub",
          filter: Protocol.prefixFilter(["users"]),
        });
        sendClient(b.socket, {
          _tag: "Subscribe",
          id: "b-sub",
          filter: Protocol.prefixFilter(["users"]),
        });
        yield* Effect.sleep(Duration.millis(50));

        sendClient(a.socket, {
          _tag: "Push",
          id: "a-push",
          mutations: [{ mutationId: "m1", key: ["users", "1"], input: { name: "Ada" } }],
        });
        yield* Effect.sleep(Duration.millis(50));

        a.socket.close();
        b.socket.close();
        const bReceived = b.received;

        const tags = bReceived.map((m) => m._tag);
        expect(tags).toContain("SubscribeAck");
        expect(tags).toContain("Updated");
        const updated = asTag(
          bReceived.find((m) => m._tag === "Updated"),
          "Updated"
        );
        expect(updated.entry.value).toEqual({ name: "Ada" });
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );

  it.live(
    "acknowledges a Push with an Applied result",
    () =>
      Effect.gen(function* () {
        const { port } = yield* WebSocketServer.serve({ port: 0 });
        const client = yield* Effect.promise(() => openClient(port));
        sendClient(client.socket, {
          _tag: "Push",
          id: "push-1",
          mutations: [{ mutationId: "m1", key: ["docs", "1"], input: { text: "hi" } }],
        });
        yield* Effect.sleep(Duration.millis(50));
        client.socket.close();
        const received = client.received;

        const ack = asTag(
          received.find((m) => m._tag === "PushAck"),
          "PushAck"
        );
        expect(ack.results[0]?._tag).toBe("Applied");
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );

  it.live(
    "removes the session when a client disconnects",
    () =>
      Effect.gen(function* () {
        const hub = yield* SyncHub.SyncHub;
        const { port } = yield* WebSocketServer.serve({ port: 0 });
        const { socket } = yield* Effect.promise(() => openClient(port));

        sendClient(socket, {
          _tag: "Subscribe",
          id: "sub-1",
          filter: Protocol.prefixFilter(["users"]),
        });
        yield* Effect.sleep(Duration.millis(50));
        const connected = yield* hub.connectedSessions;

        socket.close();
        yield* Effect.sleep(Duration.millis(50));

        // Publishing after disconnect must not crash even though the socket
        // is gone.
        yield* hub.publish(["users", "1"], { name: "Ada" });
        yield* Effect.sleep(Duration.millis(50));
        const afterClose = yield* hub.connectedSessions;

        expect(connected).toBe(1);
        expect(afterClose).toBe(0);
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );

  it.live(
    "terminates client connections when the scope closes",
    () =>
      Effect.gen(function* () {
        // Observe the client socket going away once the server scope closes.
        // The socket is created inside a child scope; closing it (when the
        // surrounding effect finishes) triggers server shutdown which
        // terminates clients.
        let signalGone: (() => void) | undefined;
        const gone = new Promise<void>((resolve) => {
          signalGone = resolve;
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { port } = yield* WebSocketServer.serve({ port: 0 });
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            socket.addEventListener("close", () => signalGone?.());
            socket.addEventListener("error", () => signalGone?.());
            yield* Effect.promise(() => new Promise((res) => socket.addEventListener("open", res)));
            // Leaving this scope closes the server -> terminates clients.
          })
        );

        // The connection went away (normal close or abnormal termination).
        const wentAway = yield* Effect.promise(() =>
          Promise.race([gone.then(() => true), sleep(2000).then(() => false)])
        );
        expect(wentAway).toBe(true);
      }).pipe(Effect.provide(hubLayer)),
    10_000
  );
});
