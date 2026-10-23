/**
 * KeyValueStore-backed CVR store tests: round-trips through shared storage,
 * and — the distributed payoff — two SyncServer instances sharing one CVR
 * store give a client cross-instance pull continuity (a cookie minted by
 * instance A is recognized by instance B, so no reset).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { KeyValueStore } from "effect/persistence";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Schema from "effect/Schema";
import type { ServerHandler } from "../Transport.js";
import type { PatchOp } from "../Protocol.js";
import { defined } from "./defined.js";

describe("Cvr.makeKeyValueStore", () => {
  it.effect("round-trips a CVR through shared storage", () =>
    Effect.gen(function* () {
      const writer = yield* Cvr.makeKeyValueStore();
      const cvr: Cvr.Cvr = {
        rows: new Map<string, Map<string, string | number>>([
          ["todos", new Map([["1", 7]])],
          ["notes", new Map([["n1", "v-abc"]])],
        ]),
      };
      yield* writer.set("cookie-1", cvr);

      // A second store instance over the same KVS sees it (cross-instance).
      const reader = yield* Cvr.makeKeyValueStore();
      const read = yield* reader.get("cookie-1");
      expect(read).toBeDefined();
      expect(defined(read).rows.get("todos")?.get("1")).toBe(7);
      expect(defined(read).rows.get("notes")?.get("n1")).toBe("v-abc");

      yield* writer.remove("cookie-1");
      expect(yield* reader.get("cookie-1")).toBeUndefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("an unknown cookie reads back as undefined (safe reset)", () =>
    Effect.gen(function* () {
      const store = yield* Cvr.makeKeyValueStore();
      expect(yield* store.get("never-written")).toBeUndefined();
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

const todoSet = Mutator.make("todo/set", Schema.Struct({ id: Schema.String }));
const allTodos = Subset.make({ collection: "todos" });

describe("shared CVR store across instances", () => {
  it.effect("a cookie minted by instance A is recognized by instance B", () =>
    Effect.gen(function* () {
      // One backend and one CVR store, shared by two SyncServer instances.
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(todoSet, (args, w) => w.put("todos", args.id, { id: args.id })),
        ])
      );
      const cvrStore = yield* Cvr.makeKeyValueStore();
      const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

      const instance: Effect.Effect<ServerHandler, never, Scope.Scope> = SyncServer.make.pipe(
        Effect.provideService(Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, authPolicy),
        Effect.provideService(Cvr.CvrStore, cvrStore),
        Effect.provideServiceEffect(InvalidationBus.InvalidationBus, InvalidationBus.makeInProcess)
      );
      const instanceA = yield* instance;
      const instanceB = yield* instance;

      // Commit a row through A.
      yield* instanceA.handlePush({
        clientGroupId: "g",
        mutations: [
          { clientId: "c", mutationId: 1, mutator: "todo/set", args: { id: "1" }, createdAt: 0 },
        ],
      });

      // Pull from A: full patch + cookie stored in the shared CVR store.
      const first = yield* instanceA.handlePull({
        clientGroupId: "g",
        cookie: undefined,
        subscriptions: [allTodos],
      });
      expect(first.patch.some((op: PatchOp) => op._tag === "Put")).toBe(true);

      // Pull from B presenting A's cookie: B finds the CVR in shared storage,
      // so the view is unchanged — no reset (no Clear), no redundant puts.
      const second = yield* instanceB.handlePull({
        clientGroupId: "g",
        cookie: first.cookie,
        subscriptions: [allTodos],
      });
      expect(second.patch.some((op: PatchOp) => op._tag === "Clear")).toBe(false);
      expect(second.patch).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});
