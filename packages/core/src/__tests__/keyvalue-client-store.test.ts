/**
 * KeyValueStore-backed ClientStore tests: the durable implementation
 * rehydrates losslessly (rows, journal, counters, cookie) and drives the
 * engine end to end like the memory store.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";
import type { Mutation } from "../Protocol.js";

const mutation = (mutationId: number): Mutation => ({
  clientId: "c1",
  mutationId,
  mutator: "noop",
  args: {},
  createdAt: 0,
});

describe("ClientStore.makeKeyValue", () => {
  it.effect("rehydrates rows, journal, counters, and cookie from the same KVS", () =>
    Effect.gen(function* () {
      const first = yield* ClientStoreModule.makeKeyValue();
      yield* first.putRow("todos", { id: "1", version: 1, value: { title: "persisted" } });
      yield* first.putRow("notes", { id: "n1", version: 2, value: { body: "x" } });
      yield* first.appendMutation(mutation(yield* first.nextMutationId("c1")));
      yield* first.setCookie("cookie-1");

      // A second store over the same KeyValueStore sees everything.
      const second = yield* ClientStoreModule.makeKeyValue();
      expect((yield* second.getRow("todos", "1"))?.value).toEqual({ title: "persisted" });
      expect(yield* second.listRows("notes")).toHaveLength(1);
      expect(yield* second.pendingMutations).toHaveLength(1);
      expect(yield* second.getCookie).toBe("cookie-1");
      // The mutation-id counter continues, never restarts.
      expect(yield* second.nextMutationId("c1")).toBe(2);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a corrupt persisted blob fails as a StoreError, not a silent bad cast", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const store = yield* ClientStoreModule.makeKeyValue();

      // Valid JSON, wrong shape: journal entries that aren't Mutations.
      yield* kv.set("effect-sync/journal", JSON.stringify([{ nope: true }]));
      const journalError = yield* Effect.flip(store.pendingMutations);
      expect(journalError._tag).toBe("StoreError");

      // Not even JSON: the row blob is garbage.
      yield* kv.set("effect-sync/rows/todos", "}{ not json");
      const rowsError = yield* Effect.flip(store.listRows("todos"));
      expect(rowsError._tag).toBe("StoreError");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("acknowledge trims the journal per client; clearRows resets rows only", () =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeKeyValue();
      yield* store.appendMutation(mutation(1));
      yield* store.appendMutation(mutation(2));
      yield* store.appendMutation({ ...mutation(1), clientId: "c2" });

      yield* store.acknowledge("c1", 1);
      const pending = yield* store.pendingMutations;
      expect(pending.map((m) => [m.clientId, m.mutationId])).toEqual([
        ["c1", 2],
        ["c2", 1],
      ]);

      yield* store.putRow("todos", { id: "1", version: 1, value: {} });
      yield* store.setCookie("keep-me");
      yield* store.clearRows;
      expect(yield* store.listRows("todos")).toEqual([]);
      expect(yield* store.getRow("todos", "1")).toBeUndefined();
      // Journal and cookie survive a row reset.
      expect(yield* store.pendingMutations).toHaveLength(2);
      expect(yield* store.getCookie).toBe("keep-me");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("prefixes isolate two stores sharing one KVS", () =>
    Effect.gen(function* () {
      const a = yield* ClientStoreModule.makeKeyValue({ prefix: "a/" });
      const b = yield* ClientStoreModule.makeKeyValue({ prefix: "b/" });
      yield* a.putRow("todos", { id: "1", version: 1, value: {} });
      yield* a.setCookie("a-cookie");
      expect(yield* b.listRows("todos")).toEqual([]);
      expect(yield* b.getCookie).toBeUndefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("drives the engine end to end as the durable store", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(
            Mutator.make("todo/set", Schema.Struct({ id: Schema.String, title: Schema.String })),
            (args, writer) => writer.put("todos", args.id, args)
          ),
        ])
      );
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
        Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
      );

      const store = yield* ClientStoreModule.makeKeyValue();
      const transport = yield* makeInMemory(handler, "group-a");
      const engine = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators: Mutator.registry([
          {
            mutator: Mutator.make(
              "todo/set",
              Schema.Struct({ id: Schema.String, title: Schema.String })
            ),
            local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
          },
        ]),
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );

      const allTodos = Subset.make({ collection: "todos" });
      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "durable" });
      yield* engine.push;
      yield* engine.pull;

      expect(yield* store.pendingMutations).toEqual([]);
      const confirmed = yield* store.listRows("todos");
      expect(confirmed.map((row) => (row.value as { title: string }).title)).toEqual(["durable"]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});
