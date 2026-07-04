/**
 * SvelteKit integration: the client-group cookie is minted once and then
 * stable; `loadSnapshot` renders a request-scoped snapshot under it; and
 * `engineRuntime` boots a client whose store took the snapshot (empty-store
 * only), rendering rows with no transport call and converging on the first
 * pull without a reset.
 */
import { describe, expect, it } from "@effect/vitest";
import type { Cookies } from "@sveltejs/kit";
import { Effect, Layer, Schema, type Scope } from "effect";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@legation/effect";
import {
  ClientEngine,
  Cvr,
  Hydration,
  InvalidationBus,
  Subset,
  SyncServer,
} from "@legation/effect/internal";
import { clientGroupId, engineRuntime, loadSnapshot } from "../index.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<Transport.ServerHandler, never, Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* MemoryBackend.make(handlers);
    const cvrStore = yield* Cvr.makeMemoryStore;
    const bus = yield* InvalidationBus.makeInProcess;
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, cvrStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
  }
);

/** A minimal fake of Kit's `Cookies` backed by a Map, recording sets. */
const fakeCookies = (): { cookies: Cookies; sets: Array<{ name: string; value: string }> } => {
  const jar = new Map<string, string>();
  const sets: Array<{ name: string; value: string }> = [];
  const cookies = {
    get: (name: string) => jar.get(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
      sets.push({ name, value });
    },
    delete: (name: string) => void jar.delete(name),
    serialize: () => "",
  } as unknown as Cookies;
  return { cookies, sets };
};

const allTodos = Subset.make({ collection: "todos" });

describe("clientGroupId", () => {
  it("mints once and stays stable across requests", () => {
    const { cookies, sets } = fakeCookies();
    const first = clientGroupId(cookies);
    const second = clientGroupId(cookies);
    expect(first).toBe(second);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.name).toBe("legation-client-group");
  });

  it("honours a custom name and generator", () => {
    const { cookies } = fakeCookies();
    const id = clientGroupId(cookies, { name: "cg", generate: () => "fixed" });
    expect(id).toBe("fixed");
    expect(cookies.get("cg")).toBe("fixed");
  });
});

describe("loadSnapshot + engineRuntime", () => {
  it.effect("SSR snapshot boots a client that renders without transport and pulls no reset", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;

      // Authoritative rows exist server-side.
      const writerStore = yield* ClientStore.makeMemory;
      const writerTransport = yield* Transport.makeInMemory(handler, "group-writer");
      const writer = yield* ClientEngine.make({
        clientId: "writer",
        clientGroupId: "group-writer",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, writerStore),
        Effect.provideService(Transport.ClientTransport, writerTransport)
      );
      yield* writer.subscribe(allTodos);
      yield* writer.mutate("todo/set", { id: "1", title: "first" });
      yield* writer.push;

      // The load: mint the group cookie, snapshot the page's subsets under it.
      const { cookies } = fakeCookies();
      const { snapshot, clientGroupId: group } = yield* loadSnapshot(cookies, {
        subsets: [allTodos],
      }).pipe(Effect.provideService(Transport.ServerHandler, handler));
      expect(snapshot.rows.map((row) => row.id)).toEqual(["1"]);
      expect(cookies.get("legation-client-group")).toBe(group);

      // The client boot: snapshot-hydrated store, engine over it.
      const runtime = engineRuntime({
        engine: { clientId: "browser", clientGroupId: group, mutators },
        store: ClientStore.layerMemory,
        transport: Transport.layerInMemory(group).pipe(
          Layer.provide(Layer.succeed(Transport.ServerHandler)(handler))
        ),
        snapshot,
      });

      const rows = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
            Effect.andThen(engine.subscribe(allTodos), engine.query(allTodos))
          )
        )
      );
      expect(rows.map((row) => row.id)).toEqual(["1"]);

      // A new authoritative write arrives on the client's first pull.
      yield* writer.mutate("todo/set", { id: "2", title: "second" });
      yield* writer.push;
      const after = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
            Effect.andThen(engine.pull, engine.query(allTodos))
          )
        )
      );
      expect(after.map((row) => row.id).toSorted()).toEqual(["1", "2"]);

      yield* Effect.promise(() => runtime.dispose());
    })
  );

  it.effect("hydrateIfEmpty leaves a populated durable store untouched", () =>
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      yield* store.putRow("todos", { id: "9", version: 9, value: { id: "9", title: "newer" } });
      yield* store.setCookie("newer-cookie");
      const stale: Hydration.Snapshot = {
        rows: [{ collection: "todos", id: "1", version: 1, value: { id: "1", title: "stale" } }],
        cookie: "stale-cookie",
        journal: [],
      };
      expect(yield* Hydration.hydrateIfEmpty(store, stale)).toBe(false);
      expect(yield* store.getCookie).toBe("newer-cookie");
      expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["9"]);
    })
  );
});
