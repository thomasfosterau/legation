/**
 * JsonApiFacade write error document tests (#512, ADR-0030 §3): what the
 * façade answers, offline, for a write it cannot journal — the `503`
 * `offline` document (with `client_id_required` or `not_journalable`
 * appended where the decision table says so), and the `400` / `409` / `422`
 * documents JSON:API prescribes for a malformed or mismatched body. Online,
 * the same requests are forwarded untouched, and an attribute value is never
 * the façade's to refuse.
 *
 * The fixture is `json-api-facade-writes.test.ts`'s, with a to-many edge
 * (`categories.notes`) for the unsupported-relationship cell.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  Authorization,
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
import { ClientEngine, ClientView } from "@thomasfosterau/legation-effect/internal";
import * as JsonApiFacade from "../JsonApiFacade.js";
import * as JsonApiQuery from "../JsonApiQuery.js";

// ─── The graph, its api and the replica ──────────────────────────────────────

const categories = Node.make("categories", {
  attributes: { name: Schema.String },
  edges: { notes: Edge.many("notes", { inverse: "category" }) },
});
const notes = Node.make("notes", {
  attributes: { title: Schema.String },
  edges: { category: Edge.one("categories", { via: "categoryId" }) },
});
const nodes = Node.registry([categories, notes]);

const open = { success: Schema.Unknown };
const idParam = { params: Schema.Struct({ id: Schema.String }), ...open };
const api = HttpApi.make("notebook")
  .add(
    HttpApiGroup.make("notebook")
      .add(HttpApiEndpoint.post("createCategory", "/categories", open))
      .add(HttpApiEndpoint.get("notes", "/notes", open))
      .add(HttpApiEndpoint.post("createNote", "/notes", open))
      .add(HttpApiEndpoint.patch("updateNote", "/notes/:id", idParam))
      .add(HttpApiEndpoint.delete("deleteNote", "/notes/:id", idParam))
  )
  .prefix("/jsonapi");

const GROUP = "group-e";
const crud = CrudMutation.entries(nodes);

const serverHandlers = R.fromEntries(
  Arr.map(
    crud,
    (entry) =>
      [
        entry.mutator.name,
        (args: unknown, writer: MemoryBackend.BackendWriter) =>
          Effect.orDie(entry.local(args, writer)),
      ] as const
  )
);

interface Fixture {
  readonly handler: JsonApiFacade.FetchHandler;
  readonly online: { current: boolean };
  /** How many mutations the engine tracks now. */
  readonly journaled: Effect.Effect<number>;
}

const makeFixture = (
  intentOf?: JsonApiFacade.Options<string, never>["intentOf"]
): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make(serverHandlers);
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
      clientId: "client-e",
      clientGroupId: GROUP,
      mutators: Mutation.registry(crud),
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    const client = Client.fromView(nodes, ClientView.fromEngine(engine), {
      urls: JsonApiQuery.urlReads(nodes),
    });
    const online = { current: false };
    const options = {
      nodes,
      api,
      view: client.view,
      coverageOf: client.coverageOf,
      cookie: store.getCookie,
      online: () => online.current,
      mutate: engine.mutateWithAck,
    };
    const handler = JsonApiFacade.fetchHandler(
      intentOf === undefined ? options : { ...options, intentOf }
    );
    const journaled = Stream.runHead(engine.mutationStates).pipe(
      Effect.map(Option.match({ onNone: () => 0, onSome: HashMap.size }))
    );
    return { handler, online, journaled };
  }).pipe(Effect.orDie);

// ─── Requests ────────────────────────────────────────────────────────────────

const MEDIA = "application/vnd.api+json";
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const write = (
  method: "POST" | "PATCH",
  url: string,
  document: unknown,
  headers: Record<string, string> = {}
): Request =>
  new Request(new URL(url, "http://notes.test"), {
    method,
    headers: { accept: MEDIA, "content-type": MEDIA, ...headers },
    body: toJson(document),
  });

const remove = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(new URL(url, "http://notes.test"), {
    method: "DELETE",
    headers: { accept: MEDIA, ...headers },
  });

/** A create without a client id. */
const withoutId = () =>
  write("POST", "/jsonapi/notes", { data: { type: "notes", attributes: { title: "a" } } });

const note = (attributes: Record<string, unknown>) => ({
  data: { type: "notes", id: "n-1", attributes },
});

const body = (response: Response): Effect.Effect<any> =>
  Effect.orDie(Effect.tryPromise(() => response.json()));

const answer = (handler: JsonApiFacade.FetchHandler, request: Request): Effect.Effect<Response> =>
  Effect.flatMap(handler.handle(request), (response) =>
    response === undefined
      ? Effect.die(`forwarded: ${request.method} ${request.url}`)
      : Effect.succeed(response)
  );

const each = <A>(items: ReadonlyArray<A>, f: (item: A) => Effect.Effect<unknown>) =>
  Effect.forEach(items, f, { concurrency: 1, discard: true });

/** Check a synthesised error: its status, headers, and the error objects' `code` / `source`. */
const expectErrors = (
  response: Response,
  status: number,
  expected: ReadonlyArray<{ readonly code: string; readonly pointer?: string }>
) =>
  Effect.gen(function* () {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(MEDIA);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(JsonApiFacade.servedAtHeader)).not.toBeNull();
    const document = yield* body(response);
    // SAFETY: a JSON:API error document's `errors` is an array of error objects.
    const errors = document.errors as ReadonlyArray<{
      status: string;
      code: string;
      source?: { pointer: string };
    }>;
    expect(
      Arr.map(errors, (error) =>
        error.source === undefined
          ? { status: error.status, code: error.code }
          : { status: error.status, code: error.code, pointer: error.source.pointer }
      )
    ).toEqual(
      Arr.map(expected, (error) =>
        error.pointer === undefined
          ? { status: String(status), code: error.code }
          : { status: String(status), code: error.code, pointer: error.pointer }
      )
    );
    return document;
  });

// ─── The decision table's error cells ────────────────────────────────────────

/** A malformed or mismatched body, the status and code it earns offline. */
const malformed: ReadonlyArray<{
  readonly name: string;
  readonly request: () => Request;
  readonly status: number;
  readonly code: string;
  readonly pointer: string;
}> = [
  {
    name: "no data member",
    request: () => write("POST", "/jsonapi/notes", { meta: {} }),
    status: 400,
    code: "invalid_document",
    pointer: "",
  },
  {
    name: "data not an object",
    request: () => write("POST", "/jsonapi/notes", { data: [] }),
    status: 400,
    code: "invalid_document",
    pointer: "/data",
  },
  {
    name: "attributes not an object",
    request: () =>
      write("PATCH", "/jsonapi/notes/n-1", {
        data: { type: "notes", id: "n-1", attributes: "x" },
      }),
    status: 400,
    code: "invalid_document",
    pointer: "/data/attributes",
  },
  {
    name: "relationships not an object",
    request: () =>
      write("POST", "/jsonapi/notes", {
        data: { type: "notes", id: "n-1", attributes: {}, relationships: [] },
      }),
    status: 400,
    code: "invalid_document",
    pointer: "/data/relationships",
  },
  {
    name: "a type that is not the route's",
    request: () =>
      write("POST", "/jsonapi/notes", { data: { type: "categories", id: "c-1", attributes: {} } }),
    status: 409,
    code: "type_mismatch",
    pointer: "/data/type",
  },
  {
    name: "a PATCH whose id is not the path's",
    request: () =>
      write("PATCH", "/jsonapi/notes/n-1", {
        data: { type: "notes", id: "n-2", attributes: { title: "x" } },
      }),
    status: 409,
    code: "id_mismatch",
    pointer: "/data/id",
  },
  {
    name: "a to-many relationship in the payload",
    request: () =>
      write("POST", "/jsonapi/categories", {
        data: {
          type: "categories",
          id: "c-1",
          attributes: { name: "Work" },
          relationships: { notes: { data: [{ type: "notes", id: "n-1" }] } },
        },
      }),
    status: 422,
    code: "unsupported_relationship",
    pointer: "/data/relationships/notes",
  },
];

describe("JsonApiFacade writes: the offline error documents", () => {
  it.effect("offline with Prefer: handling=strict, every write is the 503 offline document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, journaled } = yield* makeFixture();
        const strict = { prefer: "handling=strict" };
        yield* each(
          [
            write("POST", "/jsonapi/notes", note({ title: "a" }), strict),
            write(
              "PATCH",
              "/jsonapi/notes/n-1",
              { data: { type: "notes", id: "n-1", attributes: {} } },
              strict
            ),
            remove("/jsonapi/notes/n-1", strict),
          ],
          (request) =>
            Effect.flatMap(answer(handler, request), (response) =>
              Effect.map(expectErrors(response, 503, [{ code: "offline" }]), (document) =>
                expect(document).toEqual(JsonApiFacade.offlineDocument)
              )
            )
        );
        expect(yield* journaled).toBe(0);
      })
    )
  );

  it.effect("a POST without a client id is 503 offline plus client_id_required, both halves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online, journaled } = yield* makeFixture();
        const expected = [{ code: "offline" }, { code: "client_id_required", pointer: "/data/id" }];
        yield* expectErrors(yield* answer(handler, withoutId()), 503, expected);
        // The forward rejected at the transport while the browser reads online.
        online.current = true;
        yield* expectErrors(yield* handler.offline(withoutId()), 503, expected);
        expect(yield* journaled).toBe(0);
      })
    )
  );

  it.effect("a mutation the engine refuses is 503 offline plus not_journalable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, journaled } = yield* makeFixture((w) => ({
          mutator: `${w.type}/unknown`,
          args: {},
        }));
        const document = yield* expectErrors(
          yield* answer(handler, write("POST", "/jsonapi/notes", note({ title: "a" }))),
          503,
          [{ code: "offline" }, { code: "not_journalable" }]
        );
        expect(document.errors[1].detail).toContain("notes/unknown");
        expect(yield* journaled).toBe(0);
      })
    )
  );

  it.effect("a malformed or mismatched body is its 400, 409 or 422 document offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, journaled } = yield* makeFixture();
        yield* each(malformed, (cell) =>
          Effect.flatMap(answer(handler, cell.request()), (response) =>
            expectErrors(response, cell.status, [{ code: cell.code, pointer: cell.pointer }])
          )
        );
        expect(yield* journaled).toBe(0);
      })
    )
  );

  it.effect("online, the same malformed bodies are forwarded untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online, journaled } = yield* makeFixture();
        online.current = true;
        yield* each([{}, { prefer: "respond-async" }], (headers) =>
          each(malformed, (cell) =>
            Effect.gen(function* () {
              const request = cell.request();
              const withHeaders = new Request(request, {
                headers: { ...R.fromEntries([...request.headers]), ...headers },
              });
              expect(yield* handler.handle(withHeaders)).toBeUndefined();
              expect(withHeaders.bodyUsed).toBe(false);
            })
          )
        );
        expect(yield* journaled).toBe(0);
      })
    )
  );

  it.effect("an attribute value is never validated: a bad one offline is journaled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, journaled } = yield* makeFixture();
        const response = yield* answer(
          handler,
          write("POST", "/jsonapi/notes", note({ title: 42, unknown: true }))
        );
        expect(response.status).toBe(202);
        expect(yield* journaled).toBe(1);
      })
    )
  );
});
