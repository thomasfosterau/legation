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
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
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

/** The server's handlers: the same derived mutations, applied authoritatively. */
const serverHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "seed/put": (args, writer) => {
    const { collection, value } = args as { collection: string; value: { id: string } };
    return writer.put(collection, value.id, value);
  },
  ...Object.fromEntries(
    crud.map((entry) => [
      entry.mutator.name,
      ((args, writer) => Effect.orDie(entry.local(args, writer))) as MemoryBackend.BackendHandler,
    ])
  ),
};

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

const write = (
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  document?: unknown,
  headers: Record<string, string> = {}
): Request =>
  new Request(new URL(url, "http://notes.test"), {
    method,
    headers: {
      accept: MEDIA,
      ...(document === undefined ? {} : { "content-type": MEDIA }),
      ...headers,
    },
    ...(document === undefined ? {} : { body: JSON.stringify(document) }),
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

const deleteNote = (headers: Record<string, string> = {}) =>
  write("DELETE", "/jsonapi/notes/n-1", undefined, headers);

const body = (response: Response) => Effect.promise(() => response.json() as Promise<any>);

/** The note ids a covered `GET /jsonapi/notes` lists now. */
const listed = (handler: JsonApiFacade.FetchHandler) =>
  Effect.gen(function* () {
    const response = yield* handler.handle(read("/jsonapi/notes"));
    expect(response?.status).toBe(200);
    const document = yield* body(response!);
    return (document.data as ReadonlyArray<{ id: string; attributes: Record<string, unknown> }>)
      .map((resource) => resource.id)
      .toSorted();
  });

/** A `202` receipt's shared shape: headers, `Location` and `meta.legation`. */
const expectReceipt = (response: Response | undefined, document: any) => {
  expect(response).toBeDefined();
  expect(response!.status).toBe(202);
  expect(response!.headers.get("content-type")).toBe(MEDIA);
  expect(response!.headers.get("cache-control")).toBe("no-store");
  expect(response!.headers.get(JsonApiFacade.servedAtHeader)).not.toBeNull();
  const { mutationId } = document.meta.legation;
  expect(typeof mutationId).toBe("number");
  const location = `/jsonapi/_legation/mutations/${mutationId}`;
  expect(response!.headers.get("location")).toBe(location);
  expect(document.meta.legation).toEqual({ status: "pending", mutationId, mutation: location });
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("JsonApiFacade writes: the 202 receipt", () => {
  it.effect("offline, a POST with a client id is journaled, visible, and answered 202", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online, states } = yield* makeFixture();
        online.current = false;
        const request = createNote();
        expect(handler.matches(request)).toBe(true);
        const response = yield* handler.handle(request);
        const document = yield* body(response!);
        expectReceipt(response, document);
        expect(response!.headers.get("preference-applied")).toBeNull();
        // The resource as journaled, read back through the one writer: the `via` key is linkage.
        expect(document.data).toMatchObject({
          type: "notes",
          id: "n-2",
          attributes: { title: "Ship", body: "Today" },
          relationships: { category: { data: { type: "categories", id: "c-1" } } },
        });
        // Byte-equal to what a covered GET of the resource answers next.
        const get = yield* handler.handle(read("/jsonapi/notes/n-2"));
        expect((yield* body(get!)).data).toEqual(document.data);
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
          const response = yield* handler.handle(patchNote());
          const document = yield* body(response!);
          expectReceipt(response, document);
          expect(document.data).toMatchObject({
            type: "notes",
            id: "n-1",
            attributes: { title: "Plan B", body: "Draft" },
          });
          const get = yield* handler.handle(read("/jsonapi/notes/n-1"));
          expect((yield* body(get!)).data.attributes.title).toBe("Plan B");
          // A row the replica does not hold: journaled all the same, the update a no-op locally.
          const absent = yield* handler.handle(
            write("PATCH", "/jsonapi/notes/n-9", {
              data: { type: "notes", id: "n-9", attributes: { title: "Ghost" } },
            })
          );
          const ghost = yield* body(absent!);
          expectReceipt(absent, ghost);
          expect(ghost.data).toEqual({ type: "notes", id: "n-9", attributes: { title: "Ghost" } });
          expect(yield* listed(handler)).toEqual(["n-1"]);
        })
      )
  );

  it.effect("offline, a DELETE answers a meta-only receipt and the row leaves covered reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online } = yield* makeFixture();
        online.current = false;
        const response = yield* handler.handle(deleteNote());
        const document = yield* body(response!);
        expectReceipt(response, document);
        expect(Object.keys(document)).toEqual(["meta"]);
        expect(yield* listed(handler)).toEqual([]);
      })
    )
  );

  it.effect("online with Prefer: respond-async, every write is journaled and says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, states } = yield* makeFixture();
        const prefer = { prefer: "respond-async" };
        for (const request of [createNote(prefer), patchNote(prefer), deleteNote(prefer)]) {
          const response = yield* handler.handle(request);
          expectReceipt(response, yield* body(response!));
          expect(response!.headers.get("preference-applied")).toBe("respond-async");
        }
        expect(yield* listed(handler)).toEqual(["n-2"]);
        expect([...HashMap.values(yield* states)].map((state) => state.mutator).toSorted()).toEqual(
          ["notes/create", "notes/delete", "notes/update"]
        );
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
          const response = yield* handler.offline(clone);
          expectReceipt(response, yield* body(response));
          for (const other of [patchNote(), deleteNote()]) {
            const receipt = yield* handler.offline(other);
            expectReceipt(receipt, yield* body(receipt));
          }
          expect(HashMap.size(yield* states)).toBe(3);
          // The push delivers each intent once; a rebase replays them locally over the same rows.
          yield* engine.push;
          yield* engine.pull;
          yield* engine.pull;
          expect(yield* listed(handler)).toEqual(["n-2"]);
          const rows = yield* backend.getRows({ clientGroupId: GROUP }, "notes", ["n-1", "n-2"]);
          expect(rows.map((row) => row.id)).toEqual(["n-2"]);
          const phases = [...HashMap.values(yield* states)].map((state) => state.phase);
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
        for (const request of [createNote(), createNoteWithoutId(), patchNote(), deleteNote()]) {
          expect(handler.matches(request)).toBe(true);
          expect(yield* handler.handle(request)).toBeUndefined();
          yield* handler.forwarded(request, new Response(null, { status: 201 }));
        }
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
          for (const request of [createNote(strict), patchNote(strict), deleteNote(strict)]) {
            expect(yield* handler.handle(request)).toBeUndefined();
          }
          expect(
            yield* handler.handle(createNoteWithoutId({ prefer: "respond-async" }))
          ).toBeUndefined();
          // Offline, strict is refused rather than journaled (the 503 document is #512's to refine).
          online.current = false;
          for (const request of [createNote(strict), patchNote(strict), deleteNote(strict)]) {
            expect((yield* handler.handle(request))!.status).toBe(503);
          }
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
          write("DELETE", "/jsonapi/notes/n-1", undefined, { accept: "*/*" }),
        ];
        for (const request of notCandidates) {
          expect(handler.matches(request)).toBe(false);
          expect(yield* handler.handle(request)).toBeUndefined();
        }
      })
    )
  );

  it.effect("online with respond-async, a body it cannot journal is forwarded untouched", () =>
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
        const statuses: Array<number> = [];
        for (const offline of [false, true]) {
          online.current = !offline;
          for (const prefer of [{}, { prefer: "respond-async" }, { prefer: "handling=strict" }]) {
            for (const request of [
              createNote(prefer),
              createNoteWithoutId(prefer),
              patchNote(prefer),
              deleteNote(prefer),
            ]) {
              const response = yield* handler.handle(request);
              if (response !== undefined) statuses.push(response.status);
              statuses.push((yield* handler.offline(request.clone())).status);
            }
          }
        }
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.filter((status) => [200, 201, 204].includes(status))).toEqual([]);
      })
    )
  );
});
