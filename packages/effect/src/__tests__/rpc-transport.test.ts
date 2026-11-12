/**
 * RPC transport tests: the engine syncing over the default RPC seam — the
 * full RpcClient/RpcServer machinery via RpcTest (typed routing, streaming
 * pokes, error mapping), with the byte-level carrier skipped.
 */
import { expect, layer, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { RpcClient, RpcTest } from "effect/rpc";
import * as Authorization from "../Authorization.js";
import * as Client from "../Client.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Node from "../Node.js";
import * as RpcTransport from "../RpcTransport.js";
import * as Subset from "../Subset.js";
import * as SyncRoom from "../SyncRoom.js";
import * as Transport from "../Transport.js";
import { ClientTransport } from "../Transport.js";

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  isDone: Schema.Boolean,
});
type Todo = typeof Todo.Type;

const todoSet = Mutator.make("todo/set", Todo);

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
  layer(serverLayer)((scoped) => {
    scoped.effect("syncs end to end over the RPC machinery", () =>
      Effect.gen(function* () {
        const { engine, store } = yield* makeEngine("a");
        yield* engine.subscribe(allTodos);

        yield* engine.mutate("todo/set", { id: "1", title: "over rpc", isDone: false });
        yield* engine.push;
        yield* engine.pull;

        expect(yield* store.pendingMutations).toEqual([]);
        const confirmed = yield* store.listRows("todos");
        expect(confirmed.map((row) => (row.value as Todo).title)).toEqual(["over rpc"]);
      })
    );
  });

  layer(serverLayer)((scoped) => {
    scoped.effect("streams pokes to subscribed client groups after a push", () =>
      Effect.gen(function* () {
        const a = yield* makeEngine("a");
        const b = yield* makeEngine("b");
        yield* b.engine.subscribe(allTodos);
        // Registering the subscription server-side happens on pull.
        yield* b.engine.pull;

        const firstPoke = yield* Stream.runHead(Stream.take(b.transport.pokes, 1)).pipe(
          Effect.forkChild
        );
        yield* a.engine.mutate("todo/set", { id: "1", title: "poke me", isDone: false });
        yield* a.engine.push;

        expect((yield* Fiber.join(firstPoke))._tag).toBe("Some");
        yield* b.engine.pull;
        const seen = yield* b.engine.query(allTodos);
        expect(seen.map((row) => (row.value as Todo).title)).toEqual(["poke me"]);
      })
    );
  });

  layer(serverLayer)((scoped) => {
    scoped.effect("maps server refusals back to TransportError", () =>
      Effect.gen(function* () {
        const { engine } = yield* makeEngine("a");
        yield* engine.subscribe(Subset.make({ collection: "secrets" }));
        const failure = yield* Effect.flip(engine.pull);
        expect(failure._tag).toBe("TransportError");
        expect(failure.message).toContain("secrets");
      })
    );
  });

  layer(serverLayer)((scoped) => {
    scoped.effect("presents each call's headers to the IdentityResolver as its credentials", () =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([]);
        const resolver: Authorization.IdentityResolver = {
          resolve: ({ credentials }) =>
            Ref.update(seen, (all) => [...all, credentials.header("Authorization")]),
        };
        // `Layer.fresh`: the suite's memo map already holds `serverLayer`; this test needs its own copy
        // wired to its resolver.
        const served = yield* Layer.build(
          Layer.fresh(
            serverLayer.pipe(Layer.provide(Layer.succeed(Authorization.IdentityResolver)(resolver)))
          )
        );
        yield* Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RpcTransport.SyncRpcs);
          const withKey = RpcClient.withHeaders({ authorization: "Bearer api-key-1" });
          yield* client
            .push({ clientGroupId: "group-a", mutations: [] })
            .pipe(withKey, Effect.orDie);
          yield* client
            .pull({ clientGroupId: "group-a", subscriptions: [allTodos] })
            .pipe(withKey, Effect.orDie);
          yield* client.read({ clientGroupId: "group-a", subsets: [allTodos] }).pipe(Effect.orDie);
        }).pipe(Effect.provideContext(served));
        expect(yield* Ref.get(seen)).toEqual([
          Option.some("Bearer api-key-1"),
          Option.some("Bearer api-key-1"),
          Option.none(),
        ]);
      })
    );
  });

  layer(serverLayer)((scoped) => {
    scoped.effect("an uncovered Client.query falls through over withFallback's RPC leg (#632)", () =>
      Effect.gen(function* () {
        const writer = yield* makeEngine("writer");
        yield* writer.engine.mutate("todo/set", { id: "1", title: "on the server", isDone: false });
        yield* writer.engine.push;

        // A primary that is down (every call a TransportError) over the RPC carrier.
        const client = yield* RpcTest.makeClient(RpcTransport.SyncRpcs);
        const transport = yield* Transport.withFallback(
          Transport.offline,
          RpcTransport.fromRpcClient(client, { clientGroupId: "group-reader" })
        );
        const { client: reader } = yield* Client.make({
          nodes: Node.registry([Node.make("todos", { attributes: Todo.fields })]),
          mutations: mutators,
          transport,
          sync: false,
        });

        // Nothing is subscribed, so nothing is in the replica: the server answers.
        const rows = yield* reader.query({ collection: "todos" });
        expect(rows.map((row) => row.value)).toEqual([
          { id: "1", title: "on the server", isDone: false },
        ]);
      })
    );

    scoped.effect("fromOrigin builds the WebSocket transport with an HTTP fallback", () =>
      Effect.gen(function* () {
        // Nothing listens on the discard port: the build succeeds and the status is
        // not yet "disconnected", since no call has failed.
        const transport = yield* RpcTransport.fromOrigin({
          origin: "http://127.0.0.1:9",
          clientGroupId: "group-origin",
          httpPath: "/rpc",
          wsPath: "/rpc-ws",
          fallback: { restoreAfter: "1 second", primaryTimeout: "1 second" },
        });
        expect(["connecting", "connected"]).toContain(yield* transport.status);
        // Both carriers are RPC clients with `read`, so the fallthrough tier survives (#632).
        expect(transport.read).toBeDefined();
      }).pipe(Effect.scoped)
    );
  });
});
