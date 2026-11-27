/**
 * ClientView (ADR-0021): the narrow surface bindings consume. `fromEngine`
 * delegates reads/writes and folds the engine's ack handle into the
 * awaited-outcome shape; `layer` derives the view from the in-context engine
 * so one runtime exposes both.
 */
import { expect, layer, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { layerMemory } from "../ClientStore.js";
import * as ClientView from "../ClientView.js";
import { MutationRejected } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncRoom from "../SyncRoom.js";
import { layerInMemory } from "../Transport.js";
import { TestFailure } from "./test-failure.js";
import { idOf } from "./shapes.js";
import { ClientGroupId, RowId } from "../Protocol.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args: Todo, writer) => writer.put("todos", RowId.make(args.id), args),
  },
  {
    mutator: Mutator.make("todo/reject", Schema.Unknown),
    local: (args: Todo, writer) => writer.put("todos", RowId.make(args.id), args),
  },
]);

const handlers = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", RowId.make(idOf(args)), args)),
  "todo/reject": () => Effect.fail(new MutationRejected({ reason: "not allowed" })),
} satisfies Record<string, MemoryBackend.BackendHandler>;

const engineLayer = ClientEngineModule.layer({
  clientId: "c1",
  clientGroupId: ClientGroupId.make("group-1"),
  mutators,
}).pipe(
  Layer.provide(
    layerInMemory(ClientGroupId.make("group-1")).pipe(
      Layer.provide(
        SyncRoom.layer.pipe(
          Layer.provide(Layer.effect(Backend)(MemoryBackend.make(handlers))),
          Layer.provide(
            Layer.succeed(Authorization.AuthPolicy)(
              Authorization.policy({ todos: Authorization.allowAll })
            )
          )
        )
      )
    )
  ),
  Layer.provide(layerMemory)
);

const viewLayer = ClientView.layer.pipe(Layer.provideMerge(engineLayer));

const allTodos = Subset.make({ collection: "todos" });

describe("ClientView.fromEngine / layer", () => {
  layer(viewLayer)((scoped) => {
    scoped.effect("delegates reads and optimistic writes to the engine", () =>
      Effect.gen(function* () {
        const view = yield* ClientView.ClientView;
        yield* view.mutate("todo/set", { id: "1", title: "seed" });
        expect((yield* view.query(allTodos)).map((row) => row.id)).toEqual(["1"]);
      })
    );
  });
});

// Live clock (`excludeTestServices`): `eventually` polls on real timers.
describe("ClientView.fromEngine / layer, live", () => {
  layer(viewLayer, { excludeTestServices: true })((scoped) => {
    scoped.effect("mutateWithAck resolves with the backend's authoritative outcome", () =>
      Effect.gen(function* () {
        const view = yield* ClientView.ClientView;
        const engine = yield* ClientEngineModule.ClientEngine;
        const journaled = (id: string) =>
          eventually(view.query(allTodos), (rows) => rows.some((row) => row.id === id));

        // The call settles only when the backend acknowledges — fork, then push
        // once the optimistic row shows the mutation is journaled.
        const applied = yield* Effect.forkChild(
          view.mutateWithAck("todo/set", { id: "2", title: "ok" })
        );
        yield* journaled("2");
        yield* engine.push;
        expect(yield* Fiber.join(applied)).toEqual({ _tag: "applied" });

        const rejected = yield* Effect.forkChild(
          view.mutateWithAck("todo/reject", { id: "9", title: "doomed" })
        );
        yield* journaled("9");
        yield* engine.push;
        expect(yield* Fiber.join(rejected)).toEqual({ _tag: "rejected", reason: "not allowed" });
      })
    );
  });
});

const eventually = <A, E>(read: Effect.Effect<A, E>, until: (value: A) => boolean) => {
  const poll = (remaining: number): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const value = yield* read;
      if (until(value)) return value;
      yield* Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), 5);
        return Effect.sync(() => clearTimeout(timer));
      });
      if (remaining > 1) return yield* poll(remaining - 1);
      return yield* Effect.die(new TestFailure({ message: "eventually: condition never held" }));
    });
  return poll(200);
};
