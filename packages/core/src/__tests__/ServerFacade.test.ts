import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import * as Protocol from "../Protocol.js";
import * as ServerFacade from "../ServerFacade.js";
import * as Transport from "../Transport.js";

describe("ServerFacade.makeSyncServer", () => {
  // Pure Promise facade API, no Effect — plain async test.
  it("publishes entries and reports connected sessions", async () => {
    const server = ServerFacade.makeSyncServer();

    const entry = await server.publish(["users", "1"], { name: "Ada" });
    expect(entry.version).toBe(1);
    expect(entry.value).toEqual({ name: "Ada" });

    const second = await server.publish(["users", "1"], { name: "Grace" });
    expect(second.version).toBe(2);

    expect(await server.connectedSessions()).toBe(0);

    await server.dispose();
  });

  it.live("drives a connection: subscribe, push, and fan-out", () =>
    Effect.gen(function* () {
      const server = ServerFacade.makeSyncServer();

      // Build an in-memory transport pair; the facade drives the server side.
      const pairA = yield* Transport.makeInMemoryPair;
      const pairB = yield* Transport.makeInMemoryPair;

      // The facade handles both connections (promises resolve when connections close).
      const handleA = server.handleConnection(pairA.server);
      const handleB = server.handleConnection(pairB.server);

      // Both clients subscribe to the same prefix.
      yield* pairA.client.send(
        Protocol.ClientMessage.Subscribe({
          id: "a-sub",
          filter: Protocol.prefixFilter(["todos"]),
        })
      );
      yield* pairB.client.send(
        Protocol.ClientMessage.Subscribe({
          id: "b-sub",
          filter: Protocol.prefixFilter(["todos"]),
        })
      );
      yield* Effect.sleep(Duration.millis(50));

      // Collect what client B receives next (the fan-out).
      const collectB = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(pairB.client.messages, 2))
      );
      yield* Effect.sleep(Duration.millis(20));

      // Client A pushes a mutation.
      yield* pairA.client.send(
        Protocol.ClientMessage.Push({
          id: "a-push",
          mutations: [{ mutationId: "m1", key: ["todos", "1"], input: { title: "Ship" } }],
        })
      );

      const received = yield* Fiber.join(collectB);

      // Close both connections so the facade promises resolve.
      yield* pairA.server.close;
      yield* pairB.server.close;
      yield* Effect.promise(() => Promise.all([handleA, handleB]));

      // Client B got its SubscribeAck and then the fan-out Updated.
      const tags = received.map((message) => message._tag);
      expect(tags).toContain("SubscribeAck");
      expect(tags).toContain("Updated");

      const updated = received.find((message) => message._tag === "Updated");
      expect(updated && updated._tag === "Updated" ? updated.entry.value : undefined).toEqual({
        title: "Ship",
      });

      yield* Effect.promise(() => server.dispose());
    })
  );

  it.live("fans out invalidations and removals", () =>
    Effect.gen(function* () {
      const server = ServerFacade.makeSyncServer();

      const pair = yield* Transport.makeInMemoryPair;
      const handle = server.handleConnection(pair.server);

      yield* pair.client.send(
        Protocol.ClientMessage.Subscribe({
          id: "sub",
          filter: Protocol.prefixFilter(["users"]),
        })
      );
      yield* Effect.sleep(Duration.millis(50));

      const collector = yield* Effect.forkChild(
        // SubscribeAck + Updated + Removed + Invalidated
        Stream.runCollect(Stream.take(pair.client.messages, 4))
      );
      yield* Effect.sleep(Duration.millis(20));

      yield* Effect.promise(() => server.publish(["users", "1"], { name: "Ada" }));
      yield* Effect.promise(() => server.remove(["users", "1"]));
      yield* Effect.promise(() => server.invalidate(Protocol.prefixFilter(["users"])));

      const received = yield* Fiber.join(collector);

      yield* pair.server.close;
      yield* Effect.promise(() => handle);

      const tags = received.map((message) => message._tag);
      expect(tags).toContain("SubscribeAck");
      expect(tags).toContain("Updated");
      expect(tags).toContain("Removed");
      expect(tags).toContain("Invalidated");

      yield* Effect.promise(() => server.dispose());
    })
  );
});
