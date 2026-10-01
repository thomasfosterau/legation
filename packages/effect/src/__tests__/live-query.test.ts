/**
 * LiveQuery tests: a live query bound to an Atom re-emits over the engine's
 * change stream — an optimistic mutate drives the Atom to a new Success.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as LiveQuery from "../LiveQuery.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const TodoArgs = Schema.Struct({ id: Schema.String, title: Schema.String });
type Todo = typeof TodoArgs.Type;
const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

const allTodos = Subset.make({ collection: "todos" });

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
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
  const store = yield* ClientStoreModule.makeMemory;
  const transport = yield* makeInMemory(handler, "group-a");
  const engine = yield* ClientEngineModule.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );
  return { engine };
});

describe("LiveQuery", () => {
  it.effect("an Atom reflects the live query and re-emits on mutate", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      yield* engine.subscribe(allTodos);

      const live = LiveQuery.make(engine);
      const atom = live.atom(allTodos);
      const registry = AtomRegistry.make();
      // Mounting starts the underlying observe stream; unmount on scope exit.
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.mount(atom)),
        (unmount) => Effect.sync(unmount)
      );

      type LiveRow = { readonly id: string; readonly value: unknown };
      const read = Effect.sync(() => registry.get(atom));
      const await1 = (predicate: (rows: ReadonlyArray<LiveRow>) => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = yield* read;
            if (AsyncResult.isSuccess(result) && predicate(result.value)) return result.value;
            yield* sleepReal(5);
          }
          return yield* Effect.die(new Error("atom never reached the expected state"));
        });

      // Initial emission: empty collection.
      yield* await1((current) => current.length === 0);

      // Optimistic mutate re-emits with the new row.
      yield* engine.mutate("todo/set", { id: "1", title: "reactive" });
      const rows = yield* await1((current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["reactive"]);
    })
  );

  it.effect("the same subset yields the same Atom", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const live = LiveQuery.make(engine);
      const a = live.atom(allTodos);
      const b = live.atom(Subset.make({ collection: "todos" }));
      expect(a).toBe(b);
    })
  );
});
