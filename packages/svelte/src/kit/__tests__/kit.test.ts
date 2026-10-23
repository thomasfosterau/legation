/**
 * SvelteKit integration: the client-group cookie is minted once and then
 * stable; `loadSnapshot` renders a request-scoped snapshot under it; and
 * `clientRuntime` boots a Client whose store took the snapshot (empty-store
 * only), reading rows with no transport call and converging on the first pull
 * without a reset.
 */
import { describe, expect, it } from "@effect/vitest";
import type { Cookies } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Hydration,
  MemoryBackend,
  Mutation,
  Node,
  type Query,
  Transport,
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Cvr,
  InvalidationBus,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import { clientGroupId, clientRuntime, loadSnapshot } from "../index.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutations = Mutation.registry([
  {
    mutator: Mutation.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const nodes = Node.registry([Node.make("todos", { attributes: { title: Schema.String } })]);

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
  const cookies: Cookies = {
    get: (name: string) => jar.get(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
      sets.push({ name, value });
    },
    delete: (name: string) => void jar.delete(name),
    serialize: () => "",
    // Nothing under test parses a `Set-Cookie` header.
    parse: () => {
      throw new Error("fakeCookies: parse is not faked");
    },
  };
  return { cookies, sets };
};

const allTodosSubset = Subset.make({ collection: "todos" });
const allTodos: Query.Read = { collection: "todos" };

describe("clientGroupId", () => {
  it("mints once and stays stable across requests", () => {
    const { cookies, sets } = fakeCookies();
    const first = clientGroupId(cookies);
    const second = clientGroupId(cookies);
    expect(first).toBe(second);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.name).toBe("legation-client-group");
  });

  it("honours a custom name and generator", () => {
    const { cookies } = fakeCookies();
    const id = clientGroupId(cookies, { name: "cg", generate: () => "fixed" });
    expect(id).toBe("fixed");
    expect(cookies.get("cg")).toBe("fixed");
  });
});

describe("loadSnapshot + clientRuntime", () => {
  it.effect("SSR snapshot boots a Client that reads without transport and pulls no reset", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;

      // Authoritative rows exist server-side.
      const writerStore = yield* ClientStore.makeMemory;
      const writerTransport = yield* Transport.makeInMemory(handler, "group-writer");
      const writer = yield* ClientEngine.make({
        clientId: "writer",
        clientGroupId: "group-writer",
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, writerStore),
        Effect.provideService(Transport.ClientTransport, writerTransport)
      );
      yield* writer.subscribe(allTodosSubset);
      yield* writer.mutate("todo/set", { id: "1", title: "first" });
      yield* writer.push;

      // The load: mint the group cookie, snapshot the page's reads under it.
      const { cookies } = fakeCookies();
      const { snapshot, clientGroupId: group } = yield* loadSnapshot(cookies, {
        nodes,
        reads: [allTodos],
      }).pipe(Effect.provideService(Transport.ServerHandler, handler));
      expect(snapshot.rows.map((row) => row.id)).toEqual(["1"]);
      expect(cookies.get("legation-client-group")).toBe(group);

      // The client boot: snapshot-hydrated store, Client over it.
      const runtime = clientRuntime({
        nodes,
        mutations,
        clientId: "browser",
        clientGroupId: group,
        store: ClientStore.layerMemory,
        transport: Transport.layerInMemory(group).pipe(
          Layer.provide(Layer.succeed(Transport.ServerHandler)(handler))
        ),
        snapshot,
        subscribe: [allTodos],
      });

      const rows = yield* Effect.promise(() =>
        runtime.runPromise(Effect.flatMap(Client.Client, (client) => client.query(allTodos)))
      );
      expect(rows.map((row) => row.id)).toEqual(["1"]);

      // A new authoritative write arrives on the client's first pull. The
      // Client owns the sync loop, so this is the loop converging, not a
      // hand-driven pull.
      yield* writer.mutate("todo/set", { id: "2", title: "second" });
      yield* writer.push;
      const after = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(Client.Client, (client) =>
            Effect.andThen(
              Effect.retry(
                Effect.flatMap(client.query(allTodos), (current) =>
                  current.length === 2 ? Effect.void : Effect.fail("not yet" as const)
                ),
                { times: 100, schedule: Schedule.spaced("20 millis") }
              ),
              client.query(allTodos)
            )
          )
        )
      );
      expect(after.map((row) => row.id).toSorted()).toEqual(["1", "2"]);

      yield* Effect.promise(() => runtime.dispose());
    })
  );

  it.effect("renders against a separate backend over a supplied transport", () =>
    Effect.gen(function* () {
      // The backend is somewhere else entirely (another Worker): the `load`
      // holds a carrier to it, not the handler. Nothing is provided to this
      // effect — `ServerHandler` never enters the load's context.
      const handler = yield* makeServer;
      const writerStore = yield* ClientStore.makeMemory;
      const writerTransport = yield* Transport.makeInMemory(handler, "group-writer");
      const writer = yield* ClientEngine.make({
        clientId: "writer",
        clientGroupId: "group-writer",
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, writerStore),
        Effect.provideService(Transport.ClientTransport, writerTransport)
      );
      yield* writer.subscribe(allTodosSubset);
      yield* writer.mutate("todo/set", { id: "1", title: "remote" });
      yield* writer.push;

      const { cookies } = fakeCookies();
      const remote: Transport.ClientTransport = yield* Transport.makeInMemory(
        handler,
        "group-remote"
      );
      const loaded = yield* loadSnapshot(cookies, {
        nodes,
        reads: [allTodos],
        transport: remote,
        cookie: { generate: () => "group-remote" },
      });

      expect(loaded.clientGroupId).toBe("group-remote");
      expect(loaded.snapshot.rows.map((row) => row.id)).toEqual(["1"]);
      expect(loaded.snapshot.cookie).toBeDefined();

      // The cookie continues the conversation: the browser's first pull over
      // its own carrier gets a delta, not a `Clear` and a full re-send.
      const browserStore = yield* ClientStore.makeMemory;
      const browserTransport = yield* Transport.makeInMemory(handler, loaded.clientGroupId);
      const browser = yield* ClientEngine.make({
        clientId: "browser",
        clientGroupId: loaded.clientGroupId,
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, browserStore),
        Effect.provideService(Transport.ClientTransport, browserTransport)
      );
      expect(yield* Hydration.hydrateIfEmpty(browserStore, loaded.snapshot)).toBe(true);
      yield* browser.subscribe(allTodosSubset);
      const patch = yield* browserTransport.pull({
        clientGroupId: loaded.clientGroupId,
        cookie: loaded.snapshot.cookie,
        subscriptions: [allTodosSubset],
      });
      expect(patch.patch.some((op) => op._tag === "Clear")).toBe(false);
      expect(patch.patch).toEqual([]);
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
