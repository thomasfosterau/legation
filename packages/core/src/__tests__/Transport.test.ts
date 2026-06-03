import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import * as Protocol from "../Protocol.js";
import * as Transport from "../Transport.js";

describe("Transport.makeInMemoryPair", () => {
  it.live("delivers client messages to the server side", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;

      const collector = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(pair.server.messages, 2))
      );
      yield* Effect.sleep(Duration.millis(10));

      yield* pair.client.send(Protocol.ClientMessage.Ping({ id: "1" }));
      yield* pair.client.send(
        Protocol.ClientMessage.Subscribe({
          id: "2",
          filter: Protocol.prefixFilter(["users"]),
        })
      );

      const received = yield* Fiber.join(collector);

      expect(received).toHaveLength(2);
      expect(received[0]?._tag).toBe("Ping");
      expect(received[1]?._tag).toBe("Subscribe");
    })
  );

  it.live("delivers server messages to the client side", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;

      const collector = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(pair.client.messages, 1))
      );
      yield* Effect.sleep(Duration.millis(10));

      yield* pair.server.send(
        Protocol.ServerMessage.Updated({
          entry: { key: ["users", "1"], value: { name: "Ada" }, version: 1, updatedAt: 123 },
        })
      );

      const received = yield* Fiber.join(collector);

      expect(received).toHaveLength(1);
      expect(received[0]?._tag).toBe("Updated");
    })
  );

  it.live("reports and updates connection status", () =>
    Effect.gen(function* () {
      const pair = yield* Transport.makeInMemoryPair;

      const initial = yield* pair.client.status;
      yield* pair.setStatus("disconnected");
      const afterDisconnect = yield* pair.client.status;

      expect(initial).toBe("connected");
      expect(afterDisconnect).toBe("disconnected");
    })
  );
});

describe("Protocol", () => {
  it("matches keys against wire filters", () => {
    expect(Protocol.matches(["users", "1"], Protocol.prefixFilter(["users"]))).toBe(true);
    expect(Protocol.matches(["posts", "1"], Protocol.prefixFilter(["users"]))).toBe(false);
    expect(Protocol.matches(["users", "1"], Protocol.exactFilter(["users", "1"]))).toBe(true);
    expect(Protocol.matches(["users", "1"], Protocol.exactFilter(["users"]))).toBe(false);
  });
});
