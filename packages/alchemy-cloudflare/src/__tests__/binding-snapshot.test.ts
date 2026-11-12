/**
 * SSR over a service binding (issue #211).
 *
 * The topology under test is the ordinary two-Worker Cloudflare shape: a front
 * Worker renders the page, a binding-only API Worker holds the sync server and
 * the database, and the only way between them is `env.API.fetch`. The render
 * takes its `Hydration.snapshot` over `BindingTransport` instead of an
 * in-process `ServerHandler`.
 *
 * The thing that has to hold is the **CVR conversation**, not the rows. A
 * snapshot whose cookie was minted by the wrong room still carries the right
 * rows — the backend is shared — so it renders perfectly and then makes the
 * browser's first pull a full reset, silently. Every assertion here is
 * therefore about the *patch* the first client pull receives: no `Clear`, and
 * no re-put of a row the snapshot already carried. The control case at the
 * bottom drops the inbound cookie and shows the rows arriving exactly as
 * before while the conversation is lost.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { awaitPromise } from "./await-promise.js";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Workers from "@alchemy.run/cloudflare/Workers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import {
  Authorization,
  Backend,
  ClientStore,
  Hydration,
  MemoryBackend,
  Mutation,
  Node,
  Transport,
  type TransportError,
  type VersionNotSupportedError,
} from "@thomasfosterau/legation";
import {
  ClientEngine,
  Cvr,
  InvalidationBus,
  type Protocol,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation/internal";
import * as BindingTransport from "../BindingTransport.js";
import { fakeBinding } from "./harness.js";
import type * as Room from "../Room.js";
import { routeOf, routes } from "../RoomProtocol.js";
import { routeSync } from "../Worker.js";
import { defined } from "./defined.js";

// ─── The app ─────────────────────────────────────────────────────────────────

const Product = Node.make("products", { attributes: { name: Schema.String } });
const nodes = Node.registry([Product]);
/** The page's read, and the subset it compiles to — the engine subscribes the latter. */
const productsRead = { collection: "products" } as const;
const allProducts = Subset.make({ collection: "products" });

const productSet = Mutation.make("product/set", Schema.Unknown);
const mutations = Mutation.registry([
  {
    mutator: productSet,
    local: (args, writer) => writer.put("products", (args as { id: string }).id, args),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "product/set": (args, writer) =>
    Effect.asVoid(writer.put("products", (args as { id: string }).id, args)),
};

// ─── The API Worker ──────────────────────────────────────────────────────────

/**
 * An in-memory room namespace: each stub's `fetch` hands the forwarded request
 * to `dispatch` as a web request, as Alchemy's stub hands it to the object.
 */
const makeNamespace = (
  dispatch: (name: string, request: Request) => Promise<Response>
): Workers.DurableObject<Room.RoomObject> =>
  fakeBinding<Workers.DurableObject<Room.RoomObject>>({
    getByName: (name: string) => ({
      fetch: (request: HttpServerRequest.HttpServerRequest) =>
        HttpServerRequest.toWeb(request).pipe(
          Effect.flatMap((web) => awaitPromise(() => dispatch(name, web))),
          Effect.map(HttpServerResponse.fromWeb),
          Effect.orDie
        ),
    }),
  });

/** The session cookie the API Worker resolves a room from. */
const sessionOf = (cookie: string | undefined): string | undefined => {
  const match = cookie === undefined ? null : /(?:^|;\s*)session=([^;]+)/.exec(cookie);
  return match?.[1];
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

interface Api {
  /** The bound Worker's fetch handler — what `env.API.fetch` reaches. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Rooms that have actually served a request, by name. */
  readonly rooms: ReadonlySet<string>;
}

/**
 * The API Worker: one sync server per room (its own CVR store), all over one
 * shared backend, behind the real `routeSync`. An unauthenticated caller falls
 * back to a public `anonymous` room rather than a 401 — a browsable catalogue,
 * and the reason a dropped cookie fails *quietly* instead of loudly.
 */
const makeApi: Effect.Effect<Api, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const policy = Authorization.policy({ products: Authorization.allowAll });
  const handlers = new Map<string, Transport.ServerHandler>();
  const served = new Set<string>();
  const scope = yield* Effect.scope;

  const handlerFor = (room: string): Effect.Effect<Transport.ServerHandler> =>
    Effect.gen(function* () {
      const existing = handlers.get(room);
      if (existing !== undefined) return existing;
      const cvrStore = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, policy),
        Effect.provideService(Cvr.CvrStore, cvrStore),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );
      handlers.set(room, handler);
      return handler;
    }).pipe(Scope.provide(scope));

  const rooms = makeNamespace(async (room, request) => {
    served.add(room);
    const handler = await Effect.runPromise(handlerFor(room));
    const path = routeOf(new URL(request.url).pathname);
    const body: unknown = await request.json();
    const badRequest = (error: TransportError | VersionNotSupportedError) =>
      Effect.succeed(new Response(JSON.stringify({ error: error.message }), { status: 400 }));
    const answer = (effect: Effect.Effect<unknown, TransportError | VersionNotSupportedError>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.map(json),
          Effect.catchTags({
            TransportError: badRequest,
            VersionNotSupportedError: badRequest,
          })
        )
      );
    if (path === routes.push) return answer(handler.handlePush(body as Protocol.PushRequest));
    if (path === routes.pull) return answer(handler.handlePull(body as Protocol.PullRequest));
    if (path === routes.read) return answer(handler.handleRead(body as Protocol.ReadRequest));
    return new Response("not found", { status: 404 });
  });

  const route = routeSync({
    rooms,
    roomIdOf: (request) => Effect.succeed(sessionOf(request.headers.cookie) ?? "anonymous"),
  });

  return {
    fetch: (request) =>
      Effect.runPromise(
        route.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request)
          ),
          Effect.map((routed) =>
            Option.match(routed, {
              onNone: () => new Response("not found", { status: 404 }),
              onSome: (response) => HttpServerResponse.toWeb(response),
            })
          ),
          Effect.orDie
        )
      ),
    rooms: served,
  };
});

// ─── Clients ─────────────────────────────────────────────────────────────────

const SESSION = "session=alice";
const GROUP = "group-browser";

/** The document request the front Worker is rendering. */
const inbound = (cookie: string | undefined): Request =>
  new Request("https://shop.example.com/products", {
    headers: cookie === undefined ? {} : { cookie },
  });

/** Record every pull patch a transport sees — the reset path is visible here. */
const recordPatches = (
  transport: Transport.ClientTransport,
  patches: Ref.Ref<ReadonlyArray<ReadonlyArray<Protocol.PatchOp>>>
): Transport.ClientTransport => ({
  ...transport,
  pull: (request) =>
    transport
      .pull(request)
      .pipe(Effect.tap((response) => Ref.update(patches, (all) => [...all, response.patch]))),
});

const makeEngine = (
  transport: Transport.ClientTransport,
  clientId: string,
  clientGroupId: string
) =>
  Effect.gen(function* () {
    const store = yield* ClientStore.makeMemory;
    const engine = yield* ClientEngine.make({
      clientId,
      clientGroupId,
      mutators: mutations,
      syncLoop: { pullInterval: "10 minutes", pushDebounce: "10 minutes" },
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    return { store, engine };
  });

const putsIn = (patches: ReadonlyArray<ReadonlyArray<Protocol.PatchOp>>): ReadonlyArray<string> =>
  patches
    .flat()
    .filter((op): op is Extract<Protocol.PatchOp, { _tag: "Put" }> => op._tag === "Put")
    .map((op) => op.id)
    .toSorted();

const hasClear = (patches: ReadonlyArray<ReadonlyArray<Protocol.PatchOp>>): boolean =>
  patches.flat().some((op) => op._tag === "Clear");

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BindingTransport", () => {
  it("forwards the inbound cookie and origin, and resolves the sync path against it", async () => {
    const seen: Array<Request> = [];
    const binding = {
      fetch: async (request: Request) => {
        seen.push(request);
        return json({ cookie: "c", patch: [], lastMutationIds: {} });
      },
    };
    const transport = BindingTransport.make({
      binding,
      request: inbound(`${SESSION}; legation-client-group=${GROUP}`),
      headers: { "x-internal": "token" },
    });

    await Effect.runPromise(
      transport.pull({ clientGroupId: GROUP, subscriptions: [] }).pipe(Effect.orDie)
    );

    const sent = defined(seen[0]);
    expect(sent.url).toBe(`https://shop.example.com/sync${routes.pull}`);
    expect(sent.headers.get("cookie")).toBe(`${SESSION}; legation-client-group=${GROUP}`);
    // A top-level navigation carries no Origin header; the front door's own
    // origin is what the bound Worker needs to see.
    expect(sent.headers.get("origin")).toBe("https://shop.example.com");
    expect(sent.headers.get("x-internal")).toBe("token");
    expect(await sent.json()).toEqual({ clientGroupId: GROUP, subscriptions: [] });
  });

  it("honours a custom sync path and an explicit inbound origin", async () => {
    const seen: Array<Request> = [];
    const binding = {
      fetch: async (request: Request) => {
        seen.push(request);
        return json({ rows: [] });
      },
    };
    const request = new Request("https://shop.example.com/products", {
      headers: { origin: "https://admin.example.com" },
    });
    const transport = BindingTransport.make({ binding, request, path: "/legation" });

    await Effect.runPromise(
      defined(transport.read)({ clientGroupId: GROUP, subsets: [] }).pipe(Effect.orDie)
    );

    expect(defined(seen[0]).url).toBe(`https://shop.example.com/legation${routes.read}`);
    expect(defined(seen[0]).headers.get("origin")).toBe("https://admin.example.com");
  });

  it("maps an HTTP failure onto a TransportError carrying the server's reason", async () => {
    const binding = {
      fetch: async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    };
    const transport = BindingTransport.make({ binding, request: inbound(SESSION) });
    const failure = await Effect.runPromise(
      Effect.flip(transport.pull({ clientGroupId: GROUP, subscriptions: [] }))
    );
    expect(failure._tag).toBe("TransportError");
    expect(failure.message).toBe("nope");
  });

  it("has no poke channel — a binding is request/response, and pull is correctness", async () => {
    const transport = BindingTransport.make({
      binding: { fetch: async () => json({}) },
      request: inbound(SESSION),
    });
    expect(await Effect.runPromise(Stream.runCollect(transport.pokes))).toEqual([]);
  });
});

describe("Hydration.snapshot over a service binding", () => {
  it.effect("the first client pull continues the CVR conversation, without a reset", () =>
    Effect.gen(function* () {
      const api = yield* makeApi;
      const binding = { fetch: api.fetch };
      const request = inbound(`${SESSION}; legation-client-group=${GROUP}`);

      // A row exists authoritatively in Alice's room before the render.
      const writer = yield* makeEngine(
        BindingTransport.make({ binding, request }),
        "writer",
        "group-writer"
      );
      yield* writer.engine.subscribe(allProducts);
      yield* writer.engine.mutate("product/set", { id: "p-1", name: "kettle" });
      yield* writer.engine.push;

      // SSR in the front Worker: no ServerHandler in context anywhere — the
      // render reaches the sync server only through `env.API.fetch`.
      const snapshot = yield* Hydration.snapshot({
        clientGroupId: GROUP,
        nodes,
        reads: [productsRead],
        transport: BindingTransport.make({ binding, request }),
      });
      expect(snapshot.rows.map((row) => row.id)).toEqual(["p-1"]);
      expect(snapshot.cookie).toBeDefined();
      // The hop reached the session's own room, not the anonymous one.
      expect(api.rooms.has("alice")).toBe(true);
      expect(api.rooms.has("anonymous")).toBe(false);

      // Browser boot over the same front door.
      const patches = yield* Ref.make<ReadonlyArray<ReadonlyArray<Protocol.PatchOp>>>([]);
      const browser = yield* makeEngine(
        recordPatches(BindingTransport.make({ binding, request }), patches),
        "browser",
        GROUP
      );
      expect(yield* Hydration.hydrateIfEmpty(browser.store, snapshot)).toBe(true);
      yield* browser.engine.subscribe(allProducts);
      // The snapshot renders with no transport call at all.
      expect((yield* browser.engine.query(allProducts)).map((row) => row.id)).toEqual(["p-1"]);
      expect(yield* Ref.get(patches)).toEqual([]);

      // A second row lands authoritatively between render and boot.
      yield* writer.engine.mutate("product/set", { id: "p-2", name: "toaster" });
      yield* writer.engine.push;

      yield* browser.engine.pull;

      // THE assertion: the server recognised the snapshot's cookie, so the
      // patch is a delta — no `Clear`, and p-1 is not re-sent.
      const seen = yield* Ref.get(patches);
      expect(hasClear(seen)).toBe(false);
      expect(putsIn(seen)).toEqual(["p-2"]);
      expect((yield* browser.engine.query(allProducts)).map((row) => row.id).toSorted()).toEqual([
        "p-1",
        "p-2",
      ]);
    })
  );

  it.effect("control: dropping the inbound cookie still renders rows, but resets the client", () =>
    Effect.gen(function* () {
      const api = yield* makeApi;
      const binding = { fetch: api.fetch };
      const request = inbound(`${SESSION}; legation-client-group=${GROUP}`);

      const writer = yield* makeEngine(
        BindingTransport.make({ binding, request }),
        "writer",
        "group-writer"
      );
      yield* writer.engine.subscribe(allProducts);
      yield* writer.engine.mutate("product/set", { id: "p-1", name: "kettle" });
      yield* writer.engine.push;

      // The broken hop: the render reaches the API without the browser's
      // session, so the anonymous room answers it.
      const snapshot = yield* Hydration.snapshot({
        clientGroupId: GROUP,
        nodes,
        reads: [productsRead],
        transport: BindingTransport.make({ binding, request: inbound(undefined) }),
      });

      // A test that merely asserts rows arrived passes here. Nothing surfaces.
      expect(snapshot.rows.map((row) => row.id)).toEqual(["p-1"]);
      expect(snapshot.cookie).toBeDefined();
      expect(api.rooms.has("anonymous")).toBe(true);

      const patches = yield* Ref.make<ReadonlyArray<ReadonlyArray<Protocol.PatchOp>>>([]);
      const browser = yield* makeEngine(
        recordPatches(BindingTransport.make({ binding, request }), patches),
        "browser",
        GROUP
      );
      yield* Hydration.hydrateIfEmpty(browser.store, snapshot);
      yield* browser.engine.subscribe(allProducts);
      yield* writer.engine.mutate("product/set", { id: "p-2", name: "toaster" });
      yield* writer.engine.push;

      yield* browser.engine.pull;

      // Alice's room never minted that cookie: reset, and everything re-sent.
      const seen = yield* Ref.get(patches);
      expect(hasClear(seen)).toBe(true);
      expect(putsIn(seen)).toEqual(["p-1", "p-2"]);
    })
  );
});
