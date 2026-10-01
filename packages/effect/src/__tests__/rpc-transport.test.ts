/**
 * RPC transport tests: the engine syncing over the default RPC seam — the
 * full RpcClient/RpcServer machinery via RpcTest (typed routing, streaming
 * pokes, error mapping), with the byte-level carrier skipped.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import * as Authorization from "../Authorization.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as RpcTransport from "../RpcTransport.js";
import * as Subset from "../Subset.js";
import * as SyncRoom from "../SyncRoom.js";
import { ClientTransport } from "../Transport.js";

const TodoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
type Todo = typeof TodoSchema.Type;

const todoSet = Mutator.make("todo/set", TodoSchema);

const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

/** One sync room behind the RPC handlers, fresh per provided layer. */
const serverLayer = RpcTransport.layerHandlers.pipe(
  Layer.provide(SyncRoom.layer),
  Layer.provide(
    MemoryBackend.layer(
      MemoryBackend.validatedHandlers([
        MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
      ])
    )
  ),
  Layer.provide(
    Layer.succeed(Authorization.AuthPolicy)(Authorization.policy({ todos: Authorization.allowAll }))
  )
);

const makeEngine = (name: string) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(RpcTransport.SyncRpcs);
    const transport = RpcTransport.fromRpcClient(client, { clientGroupId: `group-${name}` });
    const store = yield* ClientStoreModule.makeMemory;
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store, transport };
  });

const allTodos = Subset.make({ collection: "todos" });

describe("RpcTransport", () => {
  it.effect("syncs end to end over the RPC machinery", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeEngine("a");
      yield* engine.subscribe(allTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "over rpc", done: false });
      yield* engine.push;
      yield* engine.pull;

      expect(yield* store.pendingMutations).toEqual([]);
      const confirmed = yield* store.listRows("todos");
      expect(confirmed.map((row) => (row.value as Todo).title)).toEqual(["over rpc"]);
    }).pipe(Effect.provide(serverLayer))
  );

  it.effect("streams pokes to subscribed client groups after a push", () =>
    Effect.gen(function* () {
      const a = yield* makeEngine("a");
      const b = yield* makeEngine("b");
      yield* b.engine.subscribe(allTodos);
      // Registering the subscription server-side happens on pull.
      yield* b.engine.pull;

      const firstPoke = yield* Stream.runHead(Stream.take(b.transport.pokes, 1)).pipe(
        Effect.forkChild
      );
      yield* a.engine.mutate("todo/set", { id: "1", title: "poke me", done: false });
      yield* a.engine.push;

      expect((yield* Fiber.join(firstPoke))._tag).toBe("Some");
      yield* b.engine.pull;
      const seen = yield* b.engine.query(allTodos);
      expect(seen.map((row) => (row.value as Todo).title)).toEqual(["poke me"]);
    }).pipe(Effect.provide(serverLayer))
  );

  it.effect("maps server refusals back to TransportError", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine("a");
      yield* engine.subscribe(Subset.make({ collection: "secrets" }));
      const failure = yield* Effect.flip(engine.pull);
      expect(failure._tag).toBe("TransportError");
      expect(failure.message).toContain("secrets");
    }).pipe(Effect.provide(serverLayer))
  );
});
