/**
 * Node HTTP sync-server tests: the engine syncing through the full stack —
 * RpcClient over a real Node HTTP server on an ephemeral port, NDJSON
 * serialization, SyncRoom + MemoryBackend behind the route.
 */
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Authorization,
  ClientEngine,
  ClientStore,
  MemoryBackend,
  Mutator,
  RpcTransport,
  Subset,
  SyncRoom,
} from "@thomasfosterau/effect-sync-core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as HttpSyncServer from "../HttpSyncServer.js";

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
type Todo = typeof TodoArgs.Type;

const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

/** Sync RPCs at /sync on a real Node server (ephemeral port), with the
 * HttpServer left visible so the client can read the bound address. */
const serverSide = HttpRouter.serve(HttpSyncServer.layerHttp({ path: "/sync" }), {
  disableListenLog: true,
}).pipe(
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
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
);

/** The engine transport speaking real HTTP to the bound port. */
const clientSide = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die(new Error("expected a TCP address"));
    }
    return RpcTransport.layer({ clientGroupId: "group-a" }).pipe(
      Layer.provide(RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${address.port}/sync` })),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(FetchHttpClient.layer)
    );
  })
);

const testEnv = clientSide.pipe(Layer.provideMerge(serverSide));

const allTodos = Subset.make({ collection: "todos" });

describe("HttpSyncServer", () => {
  it.effect("pushes and pulls through a real Node HTTP server", () =>
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      const engine = yield* ClientEngine.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(Effect.provideService(ClientStore.ClientStore, store));

      yield* engine.subscribe(allTodos);
      yield* engine.mutate("todo/set", { id: "1", title: "over http", done: false });
      yield* engine.push;
      yield* engine.pull;

      expect(yield* store.pendingMutations).toEqual([]);
      const confirmed = yield* store.listRows("todos");
      expect(confirmed.map((row) => (row.value as Todo).title)).toEqual(["over http"]);

      // Second pull advances the cookie with an empty patch.
      const cookie = yield* store.getCookie;
      yield* engine.pull;
      expect(yield* store.getCookie).not.toBe(cookie);
    }).pipe(Effect.provide(testEnv))
  );

  it.effect("server refusals surface as TransportError through HTTP", () =>
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      const engine = yield* ClientEngine.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
      }).pipe(Effect.provideService(ClientStore.ClientStore, store));

      yield* engine.subscribe(Subset.make({ collection: "secrets" }));
      const failure = yield* Effect.flip(engine.pull);
      expect(failure._tag).toBe("TransportError");
      expect(failure.message).toContain("secrets");
    }).pipe(Effect.provide(testEnv))
  );
});
