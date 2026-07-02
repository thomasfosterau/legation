/**
 * Telemetry tests: the engine's hot paths update the `legation_*` metrics.
 * Counters are cumulative in the shared registry, so assertions use before/after
 * deltas rather than absolute values.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Metric, Schema } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) =>
    Effect.asVoid(writer.put("todos", (args as { id: string }).id, args)),
};

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const counts = Effect.all({
  pulls: Metric.value(Telemetry.pullsTotal),
  pushes: Metric.value(Telemetry.pushesTotal),
  mutations: Metric.value(Telemetry.mutationsPushedTotal),
  serverPulls: Metric.value(Telemetry.serverPullsTotal),
  patchOps: Metric.value(Telemetry.patchOps),
});

describe("Telemetry", () => {
  it.effect("records client + server pull/push metrics", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-1");
      const engine = yield* ClientEngineModule.make({
        clientId: "client-1",
        clientGroupId: "group-1",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      const before = yield* counts;
      yield* engine.subscribe(Subset.make({ collection: "todos" }));
      yield* engine.mutate("todo/set", { id: "1", title: "a" });
      yield* engine.push;
      yield* engine.pull;
      const after = yield* counts;

      expect(after.pulls.count).toBe(before.pulls.count + 1);
      expect(after.pushes.count).toBe(before.pushes.count + 1);
      expect(after.mutations.count).toBe(before.mutations.count + 1);
      expect(after.serverPulls.count).toBe(before.serverPulls.count + 1);
      // One Put op for the new row.
      expect(after.patchOps.count).toBe(before.patchOps.count + 1);
    }).pipe(Effect.scoped)
  );
});
