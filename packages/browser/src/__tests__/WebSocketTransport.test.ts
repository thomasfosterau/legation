import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import * as WebSocketTransport from "../WebSocketTransport.js";

interface TestServer {
  readonly url: string;
  readonly connections: Array<WsSocket>;
  readonly received: Array<unknown>;
  readonly server: WebSocketServer;
}

const startServer = (): Promise<TestServer> =>
  new Promise((resolve) => {
    const connections: Array<WsSocket> = [];
    const received: Array<unknown> = [];
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => {
      connections.push(socket);
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
    });
    server.on("listening", () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${address.port}`, connections, received, server });
    });
  });

const stopServer = (test: TestServer): Promise<void> =>
  new Promise((resolve) => test.server.close(() => resolve()));

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("WebSocketTransport", () => {
  let test: TestServer;

  beforeEach(async () => {
    test = await startServer();
  });

  afterEach(async () => {
    await stopServer(test);
  });

  it("connects and reports status connected", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* WebSocketTransport.make({ url: test.url, reconnect: false });
          // Wait until the first status change to "connected".
          yield* Stream.runHead(Stream.filter(transport.statusChanges, (s) => s === "connected"));
          return yield* transport.status;
        })
      )
    );
    expect(status).toBe("connected");
  });

  it("send() delivers a JSON-encoded ClientMessage to the server", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* WebSocketTransport.make({ url: test.url, reconnect: false });
          yield* Stream.runHead(Stream.filter(transport.statusChanges, (s) => s === "connected"));
          yield* transport.send({ _tag: "Ping", id: "ping-1" });
          yield* Effect.promise(() => waitFor(() => test.received.length >= 1));
        })
      )
    );
    expect(test.received).toEqual([{ _tag: "Ping", id: "ping-1" }]);
  });

  it("surfaces server-sent ServerMessages on the messages stream", async () => {
    const messages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* WebSocketTransport.make({ url: test.url, reconnect: false });
          const collector = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(transport.messages, 1))
          );
          yield* Effect.promise(() => waitFor(() => test.connections.length >= 1));
          test.connections[0]!.send(
            JSON.stringify({
              _tag: "Updated",
              entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 123 },
            })
          );
          return yield* Fiber.join(collector);
        })
      )
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?._tag).toBe("Updated");
  });

  it("transitions to disconnected when the server closes the connection", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* WebSocketTransport.make({ url: test.url, reconnect: false });
          yield* Stream.runHead(Stream.filter(transport.statusChanges, (s) => s === "connected"));
          yield* Effect.promise(() => waitFor(() => test.connections.length >= 1));
          yield* Effect.sync(() => test.connections[0]!.close());
          yield* Stream.runHead(
            Stream.filter(transport.statusChanges, (s) => s === "disconnected")
          );
          return yield* transport.status;
        })
      )
    );
    expect(status).toBe("disconnected");
  });

  it("reconnects after the server closes the connection", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* WebSocketTransport.make({
            url: test.url,
            reconnect: true,
            reconnectBaseDelay: Duration.millis(20),
          });
          yield* Effect.promise(() => waitFor(() => test.connections.length >= 1));
          // Close the first connection from the server side.
          yield* Effect.sync(() => test.connections[0]!.close());
          // The transport should re-dial, producing a second connection.
          yield* Effect.promise(() => waitFor(() => test.connections.length >= 2, 3000));
        })
      )
    );
    expect(test.connections.length).toBeGreaterThanOrEqual(2);
  });
});
