/**
 * Serialized invalidation-bus tests: two SyncServer "instances" sharing one
 * broker fan a committed write out across the serialization boundary — a
 * push on instance A pokes a session registered on instance B.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import type { ServerHandler } from "../Transport.js";

const todoSet = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));
const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, { id: args.id })),
]);

/** One server instance bound to the given bus. */
const makeInstance = (
  bus: InvalidationBus.InvalidationBus
): Effect.Effect<ServerHandler, never, Scope.Scope> =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(backendHandlers);
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
  });

const allTodos = Subset.make({ collection: "todos" });

describe("serialized InvalidationBus", () => {
  it.effect("fans a write on instance A out to a session on instance B", () =>
    Effect.gen(function* () {
      const broker = yield* InvalidationBus.makeMemoryBroker;
      const instanceA = yield* makeInstance(InvalidationBus.makeSerialized(broker));
      const instanceB = yield* makeInstance(InvalidationBus.makeSerialized(broker));

      // group-b registers its subscription on instance B (via a pull).
      yield* instanceB.handlePull({
        clientGroupId: "group-b",
        cookie: undefined,
        subscriptions: [allTodos],
      });

      const poke = yield* Stream.runHead(Stream.take(instanceB.pokes("group-b"), 1)).pipe(
        Effect.forkScoped
      );

      // A commits a write touching `todos`; the hint crosses the broker.
      yield* instanceA.handlePush({
        clientGroupId: "group-a",
        mutations: [
          { clientId: "c-a", mutationId: 1, mutator: "todo/set", args: { id: "1" }, createdAt: 0 },
        ],
      });

      expect((yield* Fiber.join(poke))._tag).toBe("Some");
    }).pipe(Effect.scoped)
  );

  it.effect("a group that never subscribed is not poked", () =>
    Effect.gen(function* () {
      const broker = yield* InvalidationBus.makeMemoryBroker;
      const instanceA = yield* makeInstance(InvalidationBus.makeSerialized(broker));
      const instanceB = yield* makeInstance(InvalidationBus.makeSerialized(broker));

      yield* instanceB.handlePull({
        clientGroupId: "group-b",
        cookie: undefined,
        subscriptions: [allTodos],
      });

      yield* instanceA.handlePush({
        clientGroupId: "group-a",
        mutations: [
          { clientId: "c-a", mutationId: 1, mutator: "todo/set", args: { id: "1" }, createdAt: 0 },
        ],
      });

      // group-other never registered a subscription, so it is never poked:
      // the listener loses the race to a short real-time timeout.
      const outcome = yield* Effect.race(
        Stream.runHead(instanceB.pokes("group-other")).pipe(Effect.as("poked")),
        sleepReal(60).pipe(Effect.as("quiet"))
      );
      expect(outcome).toBe("quiet");
    }).pipe(Effect.scoped)
  );
});
