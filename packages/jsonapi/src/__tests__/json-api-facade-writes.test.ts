/**
 * JsonApiFacade write tests (#510, ADR-0030 §1, §3, §5): the `202 Accepted`
 * write receipt. A reflected `POST` / `PATCH` / `DELETE` is journaled as a
 * graph-derived CRUD mutation (`CrudMutation`) and answered before the
 * server has ruled — offline, after a forward that rejected at the
 * transport, or online on `Prefer: respond-async` — and forwarded unchanged,
 * journaling nothing, in every other cell of §3's decision table.
 *
 * The replica is a `MemoryBackend` behind a `Server` whose handlers are the
 * same derived mutations, synced into an owned engine over an in-memory
 * transport and read through a `Client`, as in `json-api-facade.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  Authorization,
  type Backend,
  Client,
  ClientStore,
  CrudMutation,
  Edge,
  MemoryBackend,
  Mutation,
  Node,
  Server,
  Transport,
} from "@thomasfosterau/legation-effect";
import type { MutationState } from "@thomasfosterau/legation-effect/internal";
import { ClientEngine, ClientView } from "@thomasfosterau/legation-effect/internal";
import * as JsonApiFacade from "../JsonApiFacade.js";
import * as JsonApiQuery from "../JsonApiQuery.js";

// ─── The graph and its api ───────────────────────────────────────────────────

const categories = Node.make("categories", { attributes: { name: Schema.String } });
const notes = Node.make("notes", {
  attributes: { title: Schema.String, body: Schema.String },
  edges: { category: Edge.one("categories", { via: "categoryId" }) },
});
const nodes = Node.registry([categories, notes]);

const open = { success: Schema.Unknown };
const idParam = { params: Schema.Struct({ id: Schema.String }), ...open };
const api = HttpApi.make("notebook")
  .add(
    HttpApiGroup.make("notebook")
      .add(HttpApiEndpoint.get("categories", "/categories", open))
      // A `PUT` update: reflected as `update`, never intercepted (JSON:API has no `PUT`).
      .add(HttpApiEndpoint.put("replaceCategory", "/categories/:id", idParam))
      .add(HttpApiEndpoint.get("notes", "/notes", open))
      .add(HttpApiEndpoint.get("note", "/notes/:id", idParam))
      .add(HttpApiEndpoint.post("createNote", "/notes", open))
      .add(HttpApiEndpoint.patch("updateNote", "/notes/:id", idParam))
      .add(HttpApiEndpoint.delete("deleteNote", "/notes/:id", idParam))
  )
  .prefix("/jsonapi");

const GROUP = "group-w";

// ─── The replica ─────────────────────────────────────────────────────────────

const crud = CrudMutation.entries(nodes);

const SeedPut = Schema.Struct({
  collection: Schema.String,
  value: Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
});

/** The server's handlers: the same derived mutations, applied authoritatively. */
const serverHandlers = R.fromEntries([
  [
    "seed/put",
    (args: unknown, writer: MemoryBackend.BackendWriter) =>
      Effect.flatMap(Effect.orDie(Schema.decodeUnknownEffect(SeedPut)(args)), (seed) =>
        writer.put(seed.collection, seed.value.id, seed.value)
      ),
  ],
  ...Arr.map(
    crud,
    (entry) =>
      [
        entry.mutator.name,
        (args: unknown, writer: MemoryBackend.BackendWriter) =>
          Effect.orDie(entry.local(args, writer)),
      ] as const
  ),
]);

interface Fixture {
  readonly handler: JsonApiFacade.FetchHandler;
  readonly engine: ClientEngine.ClientEngine;
  readonly backend: Backend.Backend;
  readonly online: { current: boolean };
  readonly pulls: { count: number };
  /** The mutation-state map now. */
  readonly states: Effect.Effect<MutationState.MutationStateMap>;
}

const makeFixture = (
  options: Partial<Pick<JsonApiFacade.Options<string, never>, "intentOf" | "writes">> = {}
): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(serverHandlers);
    yield* backend.applyMutations({ clientGroupId: "seed" }, [
      {
        clientId: "seed",
        mutationId: 1,
        mutator: "seed/put",
        args: { collection: "categories", value: { id: "c-1", name: "Work" } },
        createdAt: 0,
      },
      {
        clientId: "seed",
        mutationId: 2,
        mutator: "seed/put",
        args: {
          collection: "notes",
          value: { id: "n-1", categoryId: "c-1", title: "Plan", body: "Draft" },
        },
        createdAt: 0,
      },
    ]);
    const server = yield* Server.make({
      backend,
      auth: {
        policy: Authorization.policy(
          { categories: Authorization.allowAll, notes: Authorization.allowAll },
          { collections: nodes.collections }
        ),
      },
    });
    const transport = yield* Transport.makeInMemory(server.handler, GROUP);
    const store = yield* ClientStore.makeMemory;
    const engine = yield* ClientEngine.make({
      clientId: "client-w",
      clientGroupId: GROUP,
      mutators: Mutation.registry(crud),
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    const client = Client.fromView(nodes, ClientView.fromEngine(engine), {
      urls: JsonApiQuery.urlReads(nodes),
    });
    yield* client.subscribe("/jsonapi/categories");
    yield* client.subscribe("/jsonapi/notes");
    yield* engine.pull;
    const online = { current: true };
    const pulls = { count: 0 };
    const handler = JsonApiFacade.fetchHandler({
      nodes,
      api,
      view: client.view,
      coverageOf: client.coverageOf,
      cookie: store.getCookie,
      online: () => online.current,
      mutate: engine.mutateWithAck,
      pull: Effect.sync(() => void pulls.count++),
      ...options,
    });
    const states = Stream.runHead(engine.mutationStates).pipe(
      Effect.map(Option.getOrElse(() => HashMap.empty<number, MutationState.MutationState>()))
    );
    return { handler, engine, backend, online, pulls, states };
  }).pipe(Effect.orDie);

// ─── Requests ────────────────────────────────────────────────────────────────

const MEDIA = "application/vnd.api+json";

const read = (url: string): Request =>
  new Request(new URL(url, "http://notes.test"), { headers: { accept: MEDIA } });

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A write with a JSON:API document body. */
const write = (
  method: "POST" | "PATCH" | "PUT",
  url: string,
  document: unknown,
  headers: Record<string, string> = {}
): Request =>
  new Request(new URL(url, "http://notes.test"), {
    method,
    headers: { accept: MEDIA, "content-type": MEDIA, ...headers },
    body: toJson(document),
  });

/** A `DELETE`: no body, no `Content-Type`. */
const remove = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(new URL(url, "http://notes.test"), {
    method: "DELETE",
    headers: { accept: MEDIA, ...headers },
  });

const createNote = (headers: Record<string, string> = {}) =>
  write(
    "POST",
    "/jsonapi/notes",
    {
      data: {
        type: "notes",
        id: "n-2",
        attributes: { title: "Ship", body: "Today" },
        relationships: { category: { data: { type: "categories", id: "c-1" } } },
      },
    },
    headers
  );

const createNoteWithoutId = (headers: Record<string, string> = {}) =>
  write(
    "POST",
    "/jsonapi/notes",
    { data: { type: "notes", attributes: { title: "Ship", body: "Today" } } },
    headers
  );

const patchNote = (headers: Record<string, string> = {}) =>
  write(
    "PATCH",
    "/jsonapi/notes/n-1",
    { data: { type: "notes", id: "n-1", attributes: { title: "Plan B" } } },
    headers
  );

const deleteNote = (headers: Record<string, string> = {}) => remove("/jsonapi/notes/n-1", headers);

const body = (response: Response): Effect.Effect<any> =>
  Effect.orDie(Effect.tryPromise(() => response.json()));

/** The façade's own answer to a request; a forward (`undefined`) is a test failure. */
const answer = (handler: JsonApiFacade.FetchHandler, request: Request): Effect.Effect<Response> =>
  Effect.flatMap(handler.handle(request), (response) =>
    response === undefined
      ? Effect.die(`forwarded: ${request.method} ${request.url}`)
      : Effect.succeed(response)
  );

/** Run `f` over each item in order. */
const each = <A>(items: ReadonlyArray<A>, f: (item: A) => Effect.Effect<unknown>) =>
  Effect.forEach(items, f, { concurrency: 1, discard: true });

/** The note ids a covered `GET /jsonapi/notes` lists now. */
const listed = (handler: JsonApiFacade.FetchHandler) =>
  Effect.gen(function* () {
    const response = yield* answer(handler, read("/jsonapi/notes"));
    expect(response.status).toBe(200);
    const document = yield* body(response);
    // SAFETY: a collection document's `data` is an array of resource objects.
    const resources = document.data as ReadonlyArray<{ id: string }>;
    return Arr.sort(
      Arr.map(resources, (resource) => resource.id),
      Order.String
    );
  });

/** A `202` receipt's shared shape: headers, `Location` and `meta.legation`. */
const expectReceipt = (response: Response, document: any) => {
  expect(response.status).toBe(202);
  expect(response.headers.get("content-type")).toBe(MEDIA);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get(JsonApiFacade.servedAtHeader)).not.toBeNull();
  const { mutationId } = document.meta.legation;
  expect(typeof mutationId).toBe("number");
  const location = `/jsonapi/_legation/mutations/${mutationId}`;
  expect(response.headers.get("location")).toBe(location);
  expect(document.meta.legation).toEqual({ status: "pending", mutationId, mutation: location });
};

/** Answer a request as a receipt and check its shape; the document is returned. */
const receipt = (handler: JsonApiFacade.FetchHandler, request: Request) =>
  Effect.gen(function* () {
    const response = yield* answer(handler, request);
    const document = yield* body(response);
    expectReceipt(response, document);
    return { response, document };
  });

/** The mutators of the tracked mutations, sorted. */
const mutatorsOf = (map: MutationState.MutationStateMap) =>
  Arr.sort(
    Arr.map([...HashMap.values(map)], (state) => state.mutator),
    Order.String
  );

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("JsonApiFacade writes: the 202 receipt", () => {
  it.effect("offline, a POST with a client id is journaled, visible, and answered 202", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online, states } = yield* makeFixture();
        online.current = false;
        const request = createNote();
        expect(handler.matches(request)).toBe(true);
        const { response, document } = yield* receipt(handler, request);
        expect(response.headers.get("preference-applied")).toBeNull();
        // The resource as journaled, read back through the one writer: the `via` key is linkage.
        expect(document.data).toMatchObject({
          type: "notes",
          id: "n-2",
          attributes: { title: "Ship", body: "Today" },
          relationships: { category: { data: { type: "categories", id: "c-1" } } },
        });
        // Equal to what a covered GET of the resource answers next.
        const get = yield* answer(handler, read("/jsonapi/notes/n-2"));
        expect((yield* body(get)).data).toEqual(document.data);
        expect(yield* listed(handler)).toEqual(["n-1", "n-2"]);
        const state = HashMap.get(yield* states, document.meta.legation.mutationId);
        expect(Option.map(state, (entry) => [entry.mutator, entry.phase])).toEqual(
          Option.some(["notes/create", "pending"])
        );
      })
    )
  );

  it.effect(
    "offline, a PATCH answers the merged row, and one of an unknown row its own attributes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, online } = yield* makeFixture();
          online.current = false;
          const { document } = yield* receipt(handler, patchNote());
          expect(document.data).toMatchObject({
            type: "notes",
            id: "n-1",
            attributes: { title: "Plan B", body: "Draft" },
          });
          const get = yield* answer(handler, read("/jsonapi/notes/n-1"));
          expect((yield* body(get)).data.attributes.title).toBe("Plan B");
          // A row the replica does not hold: journaled all the same, the update a no-op locally.
          const ghost = yield* receipt(
            handler,
            write("PATCH", "/jsonapi/notes/n-9", {
              data: { type: "notes", id: "n-9", attributes: { title: "Ghost" } },
            })
          );
          expect(ghost.document.data).toEqual({
            type: "notes",
            id: "n-9",
            attributes: { title: "Ghost" },
          });
          expect(yield* listed(handler)).toEqual(["n-1"]);
        })
      )
  );

  it.effect("offline, a DELETE answers a meta-only receipt and the row leaves covered reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online } = yield* makeFixture();
        online.current = false;
        const { document } = yield* receipt(handler, deleteNote());
        expect(R.keys(document)).toEqual(["meta"]);
        expect(yield* listed(handler)).toEqual([]);
      })
    )
  );

  it.effect("online with Prefer: respond-async, every write is journaled and says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, states } = yield* makeFixture();
        const prefer = { prefer: "respond-async" };
        yield* each([createNote(prefer), patchNote(prefer), deleteNote(prefer)], (request) =>
          Effect.map(receipt(handler, request), ({ response }) =>
            expect(response.headers.get("preference-applied")).toBe("respond-async")
          )
        );
        expect(yield* listed(handler)).toEqual(["n-2"]);
        expect(mutatorsOf(yield* states)).toEqual(["notes/create", "notes/delete", "notes/update"]);
      })
    )
  );

  it.effect(
    "a forward rejected at the transport is journaled once, and its replay is idempotent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, engine, backend, states } = yield* makeFixture();
          // Online: the façade forwards; the worker's fetch then rejects and it calls `offline`
          // with the clone it took before forwarding.
          const request = createNote();
          const clone = request.clone();
          expect(yield* handler.handle(request)).toBeUndefined();
          yield* each([clone, patchNote(), deleteNote()], (candidate) =>
            Effect.flatMap(handler.offline(candidate), (response) =>
              Effect.map(body(response), (document) => expectReceipt(response, document))
            )
          );
          expect(HashMap.size(yield* states)).toBe(3);
          // The push delivers each intent once; a rebase replays them locally over the same rows.
          yield* engine.push;
          yield* engine.pull;
          yield* engine.pull;
          expect(yield* listed(handler)).toEqual(["n-2"]);
          const rows = yield* backend.getRows({ clientGroupId: GROUP }, "notes", ["n-1", "n-2"]);
          expect(Arr.map(rows, (row) => row.id)).toEqual(["n-2"]);
          const phases = Arr.map([...HashMap.values(yield* states)], (state) => state.phase);
          expect(phases).toEqual(["acknowledged", "acknowledged", "acknowledged"]);
        })
      )
  );

  it.effect("a read candidate's transport failure is still the 503 offline document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture();
        const response = yield* handler.offline(read("/jsonapi/categories"));
        expect(response.status).toBe(503);
        expect(yield* body(response)).toEqual(JsonApiFacade.offlineDocument);
      })
    )
  );
});

describe("JsonApiFacade writes: forwarded, journaling nothing", () => {
  it.effect("online and unasked, every write is forwarded, and a 2xx signals a pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, pulls, states } = yield* makeFixture();
        yield* each([createNote(), createNoteWithoutId(), patchNote(), deleteNote()], (request) =>
          Effect.gen(function* () {
            expect(handler.matches(request)).toBe(true);
            expect(yield* handler.handle(request)).toBeUndefined();
            yield* handler.forwarded(request, new Response(null, { status: 201 }));
          })
        );
        expect(pulls.count).toBe(4);
        // Not after an error, nor for a request that is not a write candidate.
        yield* handler.forwarded(createNote(), new Response(null, { status: 422 }));
        yield* handler.forwarded(read("/jsonapi/notes"), new Response(null, { status: 200 }));
        expect(pulls.count).toBe(4);
        expect(HashMap.size(yield* states)).toBe(0);
      })
    )
  );

  it.effect(
    "Prefer: handling=strict never journals; respond-async without a client id forwards",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, online, states } = yield* makeFixture();
          const strict = { prefer: "handling=strict" };
          const strictWrites = () => [createNote(strict), patchNote(strict), deleteNote(strict)];
          yield* each(strictWrites(), (request) =>
            Effect.map(handler.handle(request), (response) => expect(response).toBeUndefined())
          );
          expect(
            yield* handler.handle(createNoteWithoutId({ prefer: "respond-async" }))
          ).toBeUndefined();
          // Offline, strict is refused rather than journaled (the 503 document is #512's to refine).
          online.current = false;
          yield* each(strictWrites(), (request) =>
            Effect.map(answer(handler, request), (response) => expect(response.status).toBe(503))
          );
          expect((yield* handler.offline(createNote(strict))).status).toBe(503);
          expect(HashMap.size(yield* states)).toBe(0);
        })
      )
  );

  it.effect("what is not an interceptable write is not the façade's business", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online } = yield* makeFixture();
        online.current = false;
        const document = { data: { type: "categories", id: "c-1", attributes: { name: "Home" } } };
        const notCandidates = [
          // A `PUT` route, reflected as `update`.
          write("PUT", "/jsonapi/categories/c-1", document),
          // A route the api does not reflect for writes.
          write("POST", "/jsonapi/categories", document),
          // The atomic extension marks the operations endpoint.
          write("POST", "/jsonapi/notes", document, {
            "content-type": `${MEDIA}; ext="https://jsonapi.org/ext/atomic"`,
          }),
          // Wrong media types.
          write("POST", "/jsonapi/notes", document, { "content-type": "application/json" }),
          remove("/jsonapi/notes/n-1", { accept: "*/*" }),
        ];
        yield* each(notCandidates, (request) =>
          Effect.map(handler.handle(request), (response) => {
            expect(handler.matches(request)).toBe(false);
            expect(response).toBeUndefined();
          })
        );
      })
    )
  );

  it.effect("online with respond-async, a write it cannot journal is forwarded untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, states } = yield* makeFixture({
          // An intent mapping naming a mutation the engine does not register.
          intentOf: (w) => ({ mutator: `${w.type}/unknown`, args: {} }),
        });
        const prefer = { prefer: "respond-async" };
        const malformed = write("POST", "/jsonapi/notes", { data: [] }, prefer);
        expect(yield* handler.handle(malformed)).toBeUndefined();
        // The body was read from a clone: the request can still be forwarded.
        expect(malformed.bodyUsed).toBe(false);
        expect(yield* handler.handle(createNote(prefer))).toBeUndefined();
        expect(HashMap.size(yield* states)).toBe(0);
      })
    )
  );

  it.effect("outside `writes`, a write route is never matched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFixture({ writes: { notes: ["create"] } });
        expect(handler.matches(createNote())).toBe(true);
        expect(handler.matches(patchNote())).toBe(false);
        expect(handler.matches(deleteNote())).toBe(false);
      })
    )
  );
});

describe("JsonApiFacade writes: never a fabricated status", () => {
  it.effect("no synthesised write response is 201, 200 or 204", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online } = yield* makeFixture();
        const preferences = [{}, { prefer: "respond-async" }, { prefer: "handling=strict" }];
        const cases = Arr.flatMap([false, true], (offline) =>
          Arr.flatMap(preferences, (prefer) =>
            Arr.map(
              [createNote, createNoteWithoutId, patchNote, deleteNote],
              (make) => [offline, make(prefer)] as const
            )
          )
        );
        const statuses = yield* Effect.forEach(
          cases,
          ([offline, request]) =>
            Effect.gen(function* () {
              online.current = !offline;
              const clone = request.clone();
              const handled = yield* handler.handle(request);
              const synthesised = yield* handler.offline(clone);
              return handled === undefined
                ? [synthesised.status]
                : [handled.status, synthesised.status];
            }),
          { concurrency: 1 }
        );
        const flat = Arr.flatten(statuses);
        expect(Arr.isReadonlyArrayNonEmpty(flat)).toBe(true);
        expect(Arr.filter(flat, (status) => [200, 201, 204].includes(status))).toEqual([]);
      })
    )
  );
});
