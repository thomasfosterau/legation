/**
 * An interrupted push still fans out (#356). The backend commit and the bus
 * publish of its hints are one uninterruptible region, so an interrupt that
 * lands after the commit cannot skip the publish: a replayed retry carries no
 * hints, so a lost publish would never be repaired.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as SyncServer from "../SyncServer.js";

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const todoSet = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));
const handlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, { id: args.id })),
]);

describe("SyncServer.handlePush and interruption (#356)", () => {
  it.effect("an interrupt after the commit still publishes the committed hints", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryBackend.make(handlers);
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Signal once the backend has committed, then park before returning, so
      // the interrupt lands between the commit and the publish.
      const parked: Backend = {
        ...memory,
        applyMutations: (context, mutations) =>
          memory.applyMutations(context, mutations).pipe(
            Effect.tap(() => Deferred.succeed(committed, undefined)),
            Effect.tap(() => Deferred.await(release))
          ),
      };
      const bus = yield* InvalidationBus.makeInProcess;
      // Subscribe before the push, so every published batch is observable.
      const subscription = yield* bus.subscribe;
      const server = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, parked),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      const push = yield* Effect.forkScoped(
        server.handlePush({
          clientGroupId: "group-a",
          mutations: [
            {
              clientId: "c-a",
              mutationId: 1,
              mutator: "todo/set",
              args: { id: "1" },
              createdAt: 0,
            },
          ],
        })
      );
      yield* Deferred.await(committed);

      // Request the interrupt from a child that starts immediately, so the
      // request is in place before the release below. Fiber.interrupt waits for
      // the handler to exit, so it runs in the child, not in this fiber.
      const interrupting = yield* Effect.forkScoped(Fiber.interrupt(push), {
        startImmediately: true,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(interrupting);

      // The hint was published before the handler finished. Nothing is
      // published on the trunk code path, so the bounded wait loses the race.
      const outcome = yield* Effect.race(
        subscription.take.pipe(Effect.map((hints) => ({ published: hints }))),
        sleepReal(1000).pipe(Effect.as({ published: undefined }))
      );
      expect(outcome.published).toMatchObject([{ collection: "todos", ids: ["1"] }]);
    }).pipe(Effect.scoped)
  );
});
