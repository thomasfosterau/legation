/**
 * JsonApiBackend atomic-operations tests
 *
 * The atomic push path over a scripted in-memory HttpClient: route
 * reflection recognises an `atomic:operations` endpoint structurally (no
 * phantom `operations` resource), a batch is one request carrying the
 * extension media type, a pointer-bearing 4xx rejects one mutation and the
 * rest is resent, transient failures move nothing, acknowledged mutations
 * are skipped on replay, and `JsonApiSync.layer` switches the path on when
 * the api advertises the extension.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Atomic } from "@thomasfosterau/effect-jsonapi";
import type { Backend } from "@thomasfosterau/legation-effect";
import { ClientEngine, Subset } from "@thomasfosterau/legation-effect/internal";
import * as Convention from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";
import * as JsonApiSync from "../JsonApiSync.js";

// A conventional JSON:API surface for `todos`, plus an atomic operations
// endpoint declared with a plain HttpApiEndpoint: what makes it atomic is its
// `atomic:operations` payload, not its path or the library that built it.
const idParam = { params: Schema.Struct({ id: Schema.String }) };
const body = { payload: Schema.Unknown, success: Schema.Unknown };
const AtomicRequest = Schema.Struct({ "atomic:operations": Schema.Array(Schema.Unknown) });
const todos = HttpApiGroup.make("todos")
  .add(HttpApiEndpoint.get("list", "/todos", { success: Schema.Unknown }))
  .add(HttpApiEndpoint.get("getOne", "/todos/:id", { ...idParam, success: Schema.Unknown }))
  .add(HttpApiEndpoint.post("create", "/todos", body))
  .add(HttpApiEndpoint.patch("update", "/todos/:id", { ...idParam, ...body }))
  .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam));
const plainApi = HttpApi.make("app").add(todos);
const api = plainApi.add(
  HttpApiGroup.make("operations").add(
    HttpApiEndpoint.post("operations", "/operations", {
      payload: AtomicRequest,
      success: Schema.Unknown,
    })
  )
);

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: any;
}

const atomicHeaders = { "Content-Type": Atomic.MEDIA_TYPE };
const jsonHeaders = { "Content-Type": "application/vnd.api+json" };
const respond = (status: number, document: unknown, headers = atomicHeaders) =>
  new Response(JSON.stringify(document), { status, headers });
const empty = (status: number) => new Response(null, { status });
const readBody = (request: { readonly body: unknown }): any => {
  const b = request.body as { _tag?: string; body?: Uint8Array };
  return b?._tag === "Uint8Array" && b.body
    ? JSON.parse(new TextDecoder().decode(b.body))
    : undefined;
};

/** A row a server holds: its attributes and, optionally, its relationships as a document has them. */
interface StoredRow {
  readonly attributes: Record<string, unknown>;
  readonly relationships?: Record<string, unknown>;
}

/** The rows a server holds, by id, for `GET /todos/:id`. */
type Rows = Readonly<Record<string, StoredRow>>;

/** A row's document, as `GET /todos/:id` answers it. */
const rowResponse = (id: string, row: StoredRow) =>
  respond(
    200,
    {
      data: {
        type: "todos",
        id,
        attributes: row.attributes,
        ...(row.relationships !== undefined ? { relationships: row.relationships } : {}),
      },
    },
    jsonHeaders
  );

/**
 * An HttpClient that records every request and answers from a script. The
 * script's index counts the writes it is asked (0, 1, …), not the reads. A
 * `GET /todos/:id` is answered from `rows` (404 when absent), or by the next
 * entry of `readStatuses` while there are any, so a test can fail a read, or by
 * the next of `readDocuments`, a 200 carrying that document, so a test can
 * answer a read with a document that names no resource. A write the server
 * accepts (a 2xx) is kept in `rows` as the server would store it, so a read
 * after a write sees the written row, as it does on a real server.
 */
const makeServer = (
  script: (request: Recorded, index: number) => Response,
  options: {
    readonly rows?: Rows;
    readonly readStatuses?: ReadonlyArray<number>;
    readonly readDocuments?: ReadonlyArray<unknown>;
  } = {}
) => {
  const requests: Array<Recorded> = [];
  const rows: Record<string, StoredRow> = { ...options.rows };
  const readStatuses = [...(options.readStatuses ?? [])];
  const readDocuments = [...(options.readDocuments ?? [])];
  let writes = 0;
  const answer = (recorded: Recorded): Response => {
    const id = recorded.path.match(/^\/todos\/([^/]+)$/)?.[1];
    if (recorded.method === "GET" && id !== undefined) {
      const status = readStatuses.shift();
      if (status !== undefined)
        return respond(status, { errors: [{ title: "Refused" }] }, jsonHeaders);
      if (readDocuments.length > 0) return respond(200, readDocuments.shift(), jsonHeaders);
      const row = rows[id];
      return row === undefined ? empty(404) : rowResponse(id, row);
    }
    if (recorded.method === "GET") return script(recorded, -1);
    const response = script(recorded, writes++);
    if (response.ok) storeWrite(rows, recorded);
    return response;
  };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname,
        headers: { ...request.headers },
        body: readBody(request),
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(request, answer(recorded));
    })
  );
  return { requests, layer: Layer.succeed(HttpClient.HttpClient)(client) };
};

/** The requests a server received that wrote (everything but reads). */
const writesOf = (server: { readonly requests: ReadonlyArray<Recorded> }) =>
  server.requests.filter((request) => request.method !== "GET");

/** The reads of one path a server received. */
const readsOf = (server: { readonly requests: ReadonlyArray<Recorded> }, path: string) =>
  server.requests.filter((request) => request.method === "GET" && request.path === path);

/** The requests a server received, as `METHOD path`, in arrival order. */
const sequenceOf = (server: { readonly requests: ReadonlyArray<Recorded> }) =>
  server.requests.map((request) => `${request.method} ${request.path}`);

/** Store one resource object as the server keeps it: an update merges over the stored row. */
const storeRow = (rows: Record<string, StoredRow>, data: any, merge: boolean): void => {
  const existing = merge ? rows[data.id] : undefined;
  rows[data.id] = {
    attributes: { ...existing?.attributes, ...data.attributes },
    ...(existing?.relationships !== undefined || data.relationships !== undefined
      ? { relationships: { ...existing?.relationships, ...data.relationships } }
      : {}),
  };
};

/** Apply the operations of one accepted atomic request to `rows`. */
const storeAtomic = (rows: Record<string, StoredRow>, request: Recorded): void => {
  for (const operation of request.body["atomic:operations"]) {
    if (operation.op === "remove") delete rows[operation.ref.id];
    else storeRow(rows, operation.data, operation.op === "update");
  }
};

/** Apply one accepted per-resource write (`POST`, `PATCH` or `DELETE /todos/:id`) to `rows`. */
const storeResource = (rows: Record<string, StoredRow>, request: Recorded): void => {
  if (request.method === "DELETE") delete rows[request.path.replace("/todos/", "")];
  else if (request.method === "PATCH") storeRow(rows, request.body.data, true);
  else storeRow(rows, request.body.data, false);
};

/** Apply one accepted write to `rows`, the way the server would store it. */
const storeWrite = (rows: Record<string, StoredRow>, request: Recorded): void => {
  if (request.path === "/operations") storeAtomic(rows, request);
  else storeResource(rows, request);
};

const { resources, registry, operations } = JsonApiSync.inspect(api);
const makeBackend = (server: ReturnType<typeof makeServer>) =>
  JsonApiBackend.make({
    baseUrl: "http://api.test",
    resources,
    mutators: registry.mutators,
    operations,
    atomic: { path: "/operations" },
  }).pipe(Effect.provide(server.layer));

const context: Backend.SyncContext = { clientGroupId: "group-1" };
const mutation = (mutationId: number, mutator: string, args: unknown) => ({
  clientId: "client-1",
  mutationId,
  mutator,
  args,
  createdAt: 0,
});
const three = [
  mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "first" } }),
  mutation(2, "todos/update", { type: "todos", id: "2", attributes: { title: "second" } }),
  mutation(3, "todos/delete", { type: "todos", id: "3" }),
];
const resource = (id: string, attributes: Record<string, unknown>) => ({
  type: "todos",
  id,
  attributes,
});
const resultsFor = (ops: ReadonlyArray<any>) =>
  Atomic.results(
    ops.map((op) =>
      op.op === "remove"
        ? Atomic.emptyResult
        : Atomic.result(resource(op.data.id, op.data.attributes))
    )
  );
const rejectionAt = (index: number, detail: string) =>
  respond(422, {
    errors: [
      {
        status: "422",
        title: "Unprocessable",
        detail,
        source: { pointer: Atomic.operationPointer(index) },
      },
    ],
  });

describe("Convention.reflectAtomic", () => {
  it("recognises the operations endpoint by its payload, wherever it is routed", () => {
    expect(Convention.reflectAtomic(api)).toEqual({
      groupId: "operations",
      name: "operations",
      method: "POST",
      path: "/operations",
    });
    expect(Convention.reflectAtomic(plainApi)).toBeUndefined();
    const custom = plainApi.add(
      HttpApiGroup.make("batch").add(
        HttpApiEndpoint.post("batch", "/api/v2/batch", {
          payload: AtomicRequest,
          success: Schema.Unknown,
        })
      )
    );
    expect(Convention.reflectAtomic(custom)?.path).toBe("/api/v2/batch");
    // The document may be one arm of a union (or behind a suspension) and is still recognised.
    const unioned = plainApi.add(
      HttpApiGroup.make("batch").add(
        HttpApiEndpoint.post("batch", "/batch", {
          payload: Schema.Union([
            Schema.Struct({ legacy: Schema.Array(Schema.Unknown) }),
            Schema.suspend(() => AtomicRequest),
          ]),
          success: Schema.Unknown,
        })
      )
    );
    expect(Convention.reflectAtomic(unioned)?.path).toBe("/batch");
    expect(Convention.reflectResources(unioned).has("batch")).toBe(false);
  });

  it("does not derive a phantom `operations` resource", () => {
    const inspected = JsonApiSync.inspect(api);
    expect([...inspected.resources.keys()]).toEqual(["todos"]);
    expect(inspected.collections.map((c) => c.name)).toEqual(["todos"]);
    expect([...inspected.registry.mutators.keys()].toSorted()).toEqual([
      "todos/create",
      "todos/delete",
      "todos/update",
    ]);
    expect(inspected.operations.has("operations/create")).toBe(false);
    expect(inspected.atomic?.path).toBe("/operations");
    expect(JsonApiSync.inspect(plainApi).atomic).toBeUndefined();
  });
});

/** The rows the server holds before `three` is pushed: the update's and the delete's targets. */
const threeRows: Rows = {
  "2": { attributes: { title: "old second", done: false } },
  "3": { attributes: { title: "old third" } },
};
const threeServer = (script: (request: Recorded, index: number) => Response) =>
  makeServer(script, { rows: threeRows });

describe("JsonApiBackend in atomic mode", () => {
  it.effect("pushes a three-mutation batch as one atomic:operations request", () =>
    Effect.gen(function* () {
      const server = threeServer((request) =>
        respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);

      const result = yield* backend.applyMutations(context, three);

      expect(writesOf(server)).toHaveLength(1);
      const [request] = writesOf(server);
      expect(request!.method).toBe("POST");
      expect(request!.path).toBe("/operations");
      expect(request!.headers["content-type"]).toBe(Atomic.MEDIA_TYPE);
      expect(request!.headers["accept"]).toBe(Atomic.MEDIA_TYPE);
      expect(request!.body).toEqual({
        "atomic:operations": [
          { op: "add", data: { type: "todos", id: "1", attributes: { title: "first" } } },
          { op: "update", data: { type: "todos", id: "2", attributes: { title: "second" } } },
          { op: "remove", ref: { type: "todos", id: "3" } },
        ],
      });
      expect(result.lastMutationIds).toEqual({ "client-1": 3 });
      expect(result.rejected).toBeUndefined();
      expect(yield* backend.lastMutationIds(context)).toEqual({ "client-1": 3 });
    })
  );

  it.effect("derives change hints from the result document, deletes as bare ids", () =>
    Effect.gen(function* () {
      // The server decorates what it stored; the hint must carry its value.
      const server = threeServer(() =>
        respond(
          200,
          Atomic.results([
            Atomic.result(resource("1", { title: "first", createdAt: "server" })),
            Atomic.result(resource("2", { title: "second" })),
            Atomic.emptyResult,
          ])
        )
      );
      const backend = yield* makeBackend(server);
      const result = yield* backend.applyMutations(context, three);
      expect(result.hints).toEqual([
        {
          collection: "todos",
          ids: ["1", "2", "3"],
          values: [
            { id: "1", value: { title: "first", createdAt: "server", id: "1", relationships: {} } },
            { id: "2", value: { title: "second", id: "2", relationships: {} } },
          ],
          // The updated and deleted rows' values before the push, as read.
          oldValues: [
            { id: "2", value: { title: "old second", done: false, id: "2", relationships: {} } },
            { id: "3", value: { title: "old third", id: "3", relationships: {} } },
          ],
        },
      ]);
    })
  );

  it.effect(
    "falls back to the row read before the push, merged with the write, without a resource",
    () =>
      Effect.gen(function* () {
        const server = threeServer(() => empty(204));
        const backend = yield* makeBackend(server);
        const result = yield* backend.applyMutations(context, three);
        expect(result.lastMutationIds).toEqual({ "client-1": 3 });
        // The fallback carries the same shape a returned resource would (`toRow`).
        expect(result.hints[0]?.values).toEqual([
          { id: "1", value: { id: "1", title: "first", relationships: {} } },
          {
            id: "2",
            value: { id: "2", title: "second", done: false, relationships: {} },
          },
        ]);
        expect(result.hints[0]?.oldValues).toEqual([
          { id: "2", value: { title: "old second", done: false, id: "2", relationships: {} } },
          { id: "3", value: { title: "old third", id: "3", relationships: {} } },
        ]);
      })
  );

  it.effect("resends without a permanently rejected operation and acknowledges all three", () =>
    Effect.gen(function* () {
      const server = threeServer((request, index) =>
        index === 0
          ? rejectionAt(1, "title taken")
          : respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);

      const result = yield* backend.applyMutations(context, three);

      expect(writesOf(server)).toHaveLength(2);
      expect(writesOf(server)[0]!.body["atomic:operations"]).toHaveLength(3);
      expect(writesOf(server)[1]!.body["atomic:operations"]).toEqual([
        { op: "add", data: { type: "todos", id: "1", attributes: { title: "first" } } },
        { op: "remove", ref: { type: "todos", id: "3" } },
      ]);
      expect(result.rejected).toEqual([
        { clientId: "client-1", mutationId: 2, reason: "title taken" },
      ]);
      expect(result.lastMutationIds).toEqual({ "client-1": 3 });
      expect(result.hints).toEqual([
        {
          collection: "todos",
          ids: ["1", "3"],
          values: [{ id: "1", value: { title: "first", id: "1", relationships: {} } }],
          oldValues: [{ id: "3", value: { title: "old third", id: "3", relationships: {} } }],
        },
      ]);
    })
  );

  it.effect(
    "a pointer below the operation still names it; several rejections drop in one round trip",
    () =>
      Effect.gen(function* () {
        const server = threeServer((request, index) =>
          index === 0
            ? respond(422, {
                errors: [
                  {
                    detail: "bad title",
                    source: { pointer: `${Atomic.operationPointer(0)}/data/attributes/title` },
                  },
                  { title: "Gone", source: { pointer: Atomic.operationPointer(2) } },
                ],
              })
            : respond(200, resultsFor(request.body["atomic:operations"]))
        );
        const backend = yield* makeBackend(server);
        const result = yield* backend.applyMutations(context, three);
        expect(writesOf(server)).toHaveLength(2);
        expect(writesOf(server)[1]!.body["atomic:operations"].map((op: any) => op.op)).toEqual([
          "update",
        ]);
        expect(result.rejected).toEqual([
          { clientId: "client-1", mutationId: 1, reason: "bad title" },
          { clientId: "client-1", mutationId: 3, reason: "Gone" },
        ]);
        expect(result.lastMutationIds).toEqual({ "client-1": 3 });
      })
  );

  it.effect("acknowledges nothing when the whole batch is rejected", () =>
    Effect.gen(function* () {
      const server = threeServer(() => rejectionAt(0, "no"));
      const backend = yield* makeBackend(server);
      const result = yield* backend.applyMutations(context, [three[0]!]);
      expect(server.requests).toHaveLength(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.hints).toEqual([]);
      expect(result.lastMutationIds).toEqual({ "client-1": 1 });
    })
  );

  it.effect("a 5xx is transient: BackendError and no ledger movement", () =>
    Effect.gen(function* () {
      const server = threeServer(() => empty(500));
      const backend = yield* makeBackend(server);
      const failure = yield* Effect.flip(backend.applyMutations(context, three));
      expect(failure._tag).toBe("BackendError");
      expect(failure.message).toContain("HTTP 500");
      expect(writesOf(server)).toHaveLength(1);
      expect(yield* backend.lastMutationIds(context)).toEqual({});
    })
  );

  it.effect("a 4xx naming no operation is transient too", () =>
    Effect.gen(function* () {
      const server = threeServer(() =>
        respond(403, { errors: [{ status: "403", title: "Forbidden" }] })
      );
      const backend = yield* makeBackend(server);
      const failure = yield* Effect.flip(backend.applyMutations(context, three));
      expect(failure._tag).toBe("BackendError");
      expect(yield* backend.lastMutationIds(context)).toEqual({});
    })
  );

  it.effect("a rejection followed by a transient failure records nothing as applied", () =>
    Effect.gen(function* () {
      // Mid-batch rejection, then the resend fails: the server holds nothing,
      // so neither the rejection nor the survivors are acknowledged — the
      // client's retry resends all three.
      const server = threeServer((_request, index) =>
        index === 0 ? rejectionAt(1, "no") : empty(503)
      );
      const backend = yield* makeBackend(server);
      const failure = yield* Effect.flip(backend.applyMutations(context, three));
      expect(failure._tag).toBe("BackendError");
      expect(writesOf(server)).toHaveLength(2);
      expect(yield* backend.lastMutationIds(context)).toEqual({});
    })
  );

  it.effect("skips acknowledged mutations on replay and rejects gaps", () =>
    Effect.gen(function* () {
      const server = threeServer((request) =>
        respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);
      yield* backend.applyMutations(context, [three[0]!, three[1]!]);

      const replay = yield* backend.applyMutations(context, [three[1]!, three[2]!]);
      expect(writesOf(server)).toHaveLength(2);
      expect(writesOf(server)[1]!.body["atomic:operations"]).toEqual([
        { op: "remove", ref: { type: "todos", id: "3" } },
      ]);
      expect(replay.lastMutationIds).toEqual({ "client-1": 3 });

      // An already-acknowledged batch sends nothing at all.
      const nothing = yield* backend.applyMutations(context, three);
      expect(writesOf(server)).toHaveLength(2);
      expect(nothing.hints).toEqual([]);

      const gap = yield* Effect.flip(
        backend.applyMutations(context, [mutation(5, "todos/delete", { type: "todos", id: "5" })])
      );
      expect(gap._tag).toBe("BackendError");
      expect(writesOf(server)).toHaveLength(2);
      expect(yield* backend.lastMutationIds(context)).toEqual({ "client-1": 3 });
    })
  );
});

/**
 * Change hints across the mutations of one push (#369, as #344 for
 * MemoryBackend). A row a later mutation of the push deletes carries no value,
 * on both delivery paths: the atomic request and the per-resource writes.
 */
type HintMode = "atomic" | "per-resource";

/**
 * The atomic path answers every operation; the per-resource path answers each
 * write with 204. `rows` are the rows the server holds before the push.
 */
const modeServer = (mode: HintMode, rows: Rows = {}) =>
  makeServer(
    (request) =>
      mode === "atomic" ? respond(200, resultsFor(request.body["atomic:operations"])) : empty(204),
    { rows }
  );

const makeModeBackend = (mode: HintMode, server: ReturnType<typeof makeServer>) =>
  JsonApiBackend.make({
    baseUrl: "http://api.test",
    resources,
    mutators: registry.mutators,
    operations,
    ...(mode === "atomic" ? { atomic: { path: "/operations" } } : {}),
  }).pipe(Effect.provide(server.layer));

for (const mode of ["atomic", "per-resource"] as const) {
  describe(`JsonApiBackend change hints across mutations, ${mode} path`, () => {
    it.effect("a create then a later delete of the same row in one push carries no value", () =>
      Effect.gen(function* () {
        const server = modeServer(mode);
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "x" } }),
          mutation(2, "todos/delete", { type: "todos", id: "1" }),
        ]);

        // The row was written then deleted: the hint names it as a delete.
        expect(result.hints).toEqual([{ collection: "todos", ids: ["1"], values: [] }]);
        expect(result.lastMutationIds).toEqual({ "client-1": 2 });
        // The row was absent before the push, so the delete reads nothing.
        expect(readsOf(server, "/todos/1")).toHaveLength(0);
      })
    );

    it.effect("an update of an existing row then a later delete carries its pre-push value", () =>
      Effect.gen(function* () {
        const server = modeServer(mode, { "1": before });
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "second" } }),
          mutation(2, "todos/delete", { type: "todos", id: "1" }),
        ]);

        // The delete leaves no new value, and the old value is the row as the push found it (#372).
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [],
            oldValues: [
              { id: "1", value: { title: "before", done: false, id: "1", relationships: {} } },
            ],
          },
        ]);
        // The read precedes the first write on both paths: it sees the row as the push found it.
        expect(sequenceOf(server)).toEqual(
          mode === "atomic"
            ? ["GET /todos/1", "POST /operations"]
            : ["GET /todos/1", "PATCH /todos/1", "DELETE /todos/1"]
        );
      })
    );

    it.effect(
      "a delete then a later create of the same row in one push carries the new value",
      () =>
        Effect.gen(function* () {
          const server = modeServer(mode, { "1": before });
          const backend = yield* makeModeBackend(mode, server);

          const result = yield* backend.applyMutations(context, [
            mutation(1, "todos/delete", { type: "todos", id: "1" }),
            mutation(2, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
          ]);

          // The row exists again at the end of the push, so its final value is hinted, and
          // the delete read the row the push found, which is its old value.
          expect(result.hints).toEqual([
            {
              collection: "todos",
              ids: ["1"],
              values: [{ id: "1", value: { title: "again", id: "1", relationships: {} } }],
              oldValues: [{ id: "1", value: beforeRow }],
            },
          ]);
        })
    );

    it.effect("create, delete, then create of the same row carries the final value", () =>
      Effect.gen(function* () {
        const server = modeServer(mode);
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "first" } }),
          mutation(2, "todos/delete", { type: "todos", id: "1" }),
          mutation(3, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
        ]);

        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [{ id: "1", value: { title: "again", id: "1", relationships: {} } }],
          },
        ]);
      })
    );

    it.effect(
      "a single update with a 204 (no-body) response carries the row read before it, merged with the write",
      () =>
        Effect.gen(function* () {
          // No response document: the hint merges the write over the row read before the push.
          const server = makeServer(() => empty(204), { rows: { "1": before } });
          const backend = yield* makeModeBackend(mode, server);

          const result = yield* backend.applyMutations(context, [
            mutation(1, "todos/update", {
              type: "todos",
              id: "1",
              attributes: { title: "second" },
            }),
          ]);

          expect(result.hints).toEqual([
            {
              collection: "todos",
              ids: ["1"],
              values: [
                { id: "1", value: { title: "second", done: false, id: "1", relationships: {} } },
              ],
              oldValues: [{ id: "1", value: beforeRow }],
            },
          ]);
        })
    );

    it.effect("[create 1, delete 1 rejected] keeps the create's value", () =>
      Effect.gen(function* () {
        // The delete is rejected, so the row still exists and its create's value is hinted.
        const server =
          mode === "atomic"
            ? makeServer((request, index) =>
                index === 0
                  ? rejectionAt(1, "gone")
                  : respond(200, resultsFor(request.body["atomic:operations"]))
              )
            : makeServer((request) =>
                request.method === "DELETE"
                  ? respond(422, {
                      errors: [{ status: "422", title: "Unprocessable", detail: "gone" }],
                    })
                  : empty(204)
              );
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "x" } }),
          mutation(2, "todos/delete", { type: "todos", id: "1" }),
        ]);

        expect(result.rejected).toEqual([
          { clientId: "client-1", mutationId: 2, reason: expect.any(String) },
        ]);
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [{ id: "1", value: { title: "x", id: "1", relationships: {} } }],
          },
        ]);
      })
    );
  });
}

/**
 * Change hints carry each row's pre-push value as `oldValues` (#372, as
 * MemoryBackend does). An update or delete reads its row before the push
 * writes it, once per row per push, on both delivery paths.
 */
const before: StoredRow = { attributes: { title: "before", done: false } };
const beforeRow = { title: "before", done: false, id: "1", relationships: {} };

/** The writes a server answers without a document: empty atomic results, or 204. */
const bareWrites = (mode: HintMode) => (request: Recorded) =>
  mode === "atomic"
    ? respond(200, Atomic.results(request.body["atomic:operations"].map(() => Atomic.emptyResult)))
    : empty(204);

for (const mode of ["atomic", "per-resource"] as const) {
  describe(`JsonApiBackend change hints carry the pre-push row, ${mode} path`, () => {
    it.effect("an update of an existing row emits its pre-push value as oldValues", () =>
      Effect.gen(function* () {
        const server = makeServer(bareWrites(mode), { rows: { "1": before } });
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
        ]);

        // A partial PATCH hints the full row: `done` is carried over from the read.
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [
              { id: "1", value: { title: "after", done: false, id: "1", relationships: {} } },
            ],
            oldValues: [{ id: "1", value: beforeRow }],
          },
        ]);
        expect(sequenceOf(server)).toEqual(
          mode === "atomic"
            ? ["GET /todos/1", "POST /operations"]
            : ["GET /todos/1", "PATCH /todos/1"]
        );
      })
    );

    it.effect("a row several writes of one push touch is read once, before the first", () =>
      Effect.gen(function* () {
        const server = makeServer(bareWrites(mode), { rows: { "1": before } });
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "a" } }),
          mutation(2, "todos/update", { type: "todos", id: "1", attributes: { title: "b" } }),
        ]);

        // One atomic request carries both writes; the per-resource path sends two.
        expect(sequenceOf(server)).toEqual(
          mode === "atomic"
            ? ["GET /todos/1", "POST /operations"]
            : ["GET /todos/1", "PATCH /todos/1", "PATCH /todos/1"]
        );
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [{ id: "1", value: { title: "b", done: false, id: "1", relationships: {} } }],
            oldValues: [{ id: "1", value: beforeRow }],
          },
        ]);
      })
    );

    it.effect("a row the push creates has no old value, and a later update merges over it", () =>
      Effect.gen(function* () {
        const server = makeServer(bareWrites(mode));
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", {
            type: "todos",
            id: "2",
            attributes: { title: "new", done: false },
          }),
          mutation(2, "todos/update", { type: "todos", id: "2", attributes: { title: "newer" } }),
        ]);

        // A row the push creates was absent before the push: neither path reads it, so a
        // 404 on that read cannot fail the push. The hint has no old value.
        expect(readsOf(server, "/todos/2")).toHaveLength(0);
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["2"],
            values: [
              { id: "2", value: { title: "newer", done: false, id: "2", relationships: {} } },
            ],
          },
        ]);
      })
    );

    it.effect("the server's document is the row's value when it returns one", () =>
      Effect.gen(function* () {
        const serverRow = { title: "after", done: false, createdAt: "server" };
        const server = makeServer(
          mode === "atomic"
            ? () => respond(200, Atomic.results([Atomic.result(resource("1", serverRow))]))
            : () => respond(200, { data: resource("1", serverRow) }, jsonHeaders),
          { rows: { "1": before } }
        );
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
        ]);

        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [
              {
                id: "1",
                value: {
                  title: "after",
                  done: false,
                  createdAt: "server",
                  id: "1",
                  relationships: {},
                },
              },
            ],
            oldValues: [{ id: "1", value: beforeRow }],
          },
        ]);
      })
    );

    it.effect("a relationship a write sets, or leaves, is hinted in the row's linkage shape", () =>
      Effect.gen(function* () {
        const withAuthor: StoredRow = {
          attributes: { title: "before", done: false },
          relationships: { author: { data: { type: "users", id: "u1" } } },
        };
        const server = makeServer(bareWrites(mode), { rows: { "1": withAuthor } });
        const backend = yield* makeModeBackend(mode, server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", {
            type: "todos",
            id: "2",
            attributes: { title: "new" },
            relationships: { author: { data: { type: "users", id: "u2" } } },
          }),
          mutation(2, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
        ]);

        // The derived update writes attributes only, so the read row's `author` carries over unchanged.
        // Rows are hinted in the order the push applied their writes.
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["2", "1"],
            values: [
              {
                id: "2",
                value: {
                  title: "new",
                  id: "2",
                  relationships: { author: { type: "users", id: "u2" } },
                },
              },
              {
                id: "1",
                value: {
                  title: "after",
                  done: false,
                  id: "1",
                  relationships: { author: { type: "users", id: "u1" } },
                },
              },
            ],
            oldValues: [
              {
                id: "1",
                value: {
                  title: "before",
                  done: false,
                  id: "1",
                  relationships: { author: { type: "users", id: "u1" } },
                },
              },
            ],
          },
        ]);
      })
    );

    it.effect(
      "a read that fails transiently fails the push, writes nothing, and a retry applies it",
      () =>
        Effect.gen(function* () {
          const server = makeServer(bareWrites(mode), {
            rows: { "1": before },
            readStatuses: [503],
          });
          const backend = yield* makeModeBackend(mode, server);
          const update = [
            mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
          ];

          const failure = yield* Effect.flip(backend.applyMutations(context, update));
          expect(failure._tag).toBe("BackendError");
          expect(failure.message).toContain("HTTP 503");
          expect(writesOf(server)).toHaveLength(0);
          expect(yield* backend.lastMutationIds(context)).toEqual({});

          const result = yield* backend.applyMutations(context, update);
          expect(writesOf(server)).toHaveLength(1);
          expect(result.lastMutationIds).toEqual({ "client-1": 1 });
          expect(result.hints[0]?.oldValues).toEqual([{ id: "1", value: beforeRow }]);
        })
    );

    it.effect(
      "a read that fails after an earlier write: atomic writes nothing, per-resource keeps that write",
      () =>
        Effect.gen(function* () {
          const server = makeServer(bareWrites(mode), {
            rows: { "1": before },
            readStatuses: [503],
          });
          const backend = yield* makeModeBackend(mode, server);
          // The create reads nothing, so the update's read is the one that fails.
          const push = [
            mutation(1, "todos/create", { type: "todos", id: "2", attributes: { title: "new" } }),
            mutation(2, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
          ];

          const failure = yield* Effect.flip(backend.applyMutations(context, push));
          expect(failure._tag).toBe("BackendError");
          // Atomic: every read precedes the one request, so nothing was sent. Per-resource:
          // the create applied and is acknowledged, so the retry does not resend it.
          expect(writesOf(server)).toHaveLength(mode === "atomic" ? 0 : 1);
          expect(yield* backend.lastMutationIds(context)).toEqual(
            mode === "atomic" ? {} : { "client-1": 1 }
          );

          const result = yield* backend.applyMutations(context, push);
          expect(writesOf(server)).toHaveLength(mode === "atomic" ? 1 : 2);
          expect(result.lastMutationIds).toEqual({ "client-1": 2 });
          // The per-resource retry hints only the update: the create's hint went with the failed push.
          expect(result.hints.map((hint) => hint.ids)).toEqual(
            mode === "atomic" ? [["2", "1"]] : [["1"]]
          );
        })
    );

    it.effect("a 2xx read whose document names no resource fails the push and sends no write", () =>
      Effect.gen(function* () {
        const server = makeServer(bareWrites(mode), { readDocuments: [{ data: null }] });
        const backend = yield* makeModeBackend(mode, server);

        const failure = yield* Effect.flip(
          backend.applyMutations(context, [
            mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
          ])
        );
        // A read with no row cannot supply the old value, so the update is not sent without one.
        expect(failure._tag).toBe("BackendError");
        expect(failure.message).toContain("returned no resource");
        expect(readsOf(server, "/todos/1")).toHaveLength(1);
        expect(writesOf(server)).toHaveLength(0);
        expect(yield* backend.lastMutationIds(context)).toEqual({});
      })
    );

    for (const status of [403, 404]) {
      it.effect(`a read refused with HTTP ${status} fails the push and writes nothing`, () =>
        Effect.gen(function* () {
          const server = makeServer(bareWrites(mode), {
            rows: { "1": before },
            readStatuses: [status],
          });
          const backend = yield* makeModeBackend(mode, server);

          const failure = yield* Effect.flip(
            backend.applyMutations(context, [
              mutation(1, "todos/update", {
                type: "todos",
                id: "1",
                attributes: { title: "after" },
              }),
            ])
          );
          // The read is the one thing that decides whether the write may go: a refused read
          // stops the push, so the server is not written and the ledger does not move.
          expect(failure._tag).toBe("BackendError");
          expect(failure.message).toContain(`HTTP ${status}`);
          expect(writesOf(server)).toHaveLength(0);
          expect(yield* backend.lastMutationIds(context)).toEqual({});
        })
      );

      it.effect(
        `a read refused with HTTP ${status} after an earlier write: atomic writes nothing, per-resource keeps that write`,
        () =>
          Effect.gen(function* () {
            const server = makeServer(bareWrites(mode), {
              rows: { "1": before },
              readStatuses: [status],
            });
            const backend = yield* makeModeBackend(mode, server);
            const push = [
              mutation(1, "todos/create", { type: "todos", id: "2", attributes: { title: "new" } }),
              mutation(2, "todos/update", {
                type: "todos",
                id: "1",
                attributes: { title: "after" },
              }),
            ];

            const failure = yield* Effect.flip(backend.applyMutations(context, push));
            expect(failure._tag).toBe("BackendError");
            expect(writesOf(server)).toHaveLength(mode === "atomic" ? 0 : 1);
            expect(yield* backend.lastMutationIds(context)).toEqual(
              mode === "atomic" ? {} : { "client-1": 1 }
            );
          })
      );
    }
  });
}

/**
 * A create the atomic path refuses (the row already exists, a conflict) leaves
 * its row in place, so a later update or delete of that row in the same batch
 * must still carry the pre-push value (#402). The batch reads that row before
 * the resend, and only when such a write is still to be sent.
 */
describe("JsonApiBackend atomic batch after a refused create (#402)", () => {
  /** The first request is refused on its create; the resend and later requests apply. */
  const refusedCreate = (request: Recorded, index: number) =>
    index === 0 ? rejectionAt(0, "exists") : bareWrites("atomic")(request);

  it.effect(
    "an update of the refused create's row carries the pre-push row, merged with the write",
    () =>
      Effect.gen(function* () {
        const server = makeServer(refusedCreate, { rows: { "1": before } });
        const backend = yield* makeModeBackend("atomic", server);

        const result = yield* backend.applyMutations(context, [
          mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
          mutation(2, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
        ]);

        // The refused request, the read of the row, then the resend without the create.
        expect(sequenceOf(server)).toEqual([
          "POST /operations",
          "GET /todos/1",
          "POST /operations",
        ]);
        expect(result.rejected).toEqual([
          { clientId: "client-1", mutationId: 1, reason: "exists" },
        ]);
        expect(result.lastMutationIds).toEqual({ "client-1": 2 });
        expect(result.hints).toEqual([
          {
            collection: "todos",
            ids: ["1"],
            values: [
              { id: "1", value: { title: "after", done: false, id: "1", relationships: {} } },
            ],
            oldValues: [{ id: "1", value: beforeRow }],
          },
        ]);
      })
  );

  it.effect("a delete of the refused create's row carries the pre-push row", () =>
    Effect.gen(function* () {
      const server = makeServer(refusedCreate, { rows: { "1": before } });
      const backend = yield* makeModeBackend("atomic", server);

      const result = yield* backend.applyMutations(context, [
        mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
        mutation(2, "todos/delete", { type: "todos", id: "1" }),
      ]);

      expect(sequenceOf(server)).toEqual(["POST /operations", "GET /todos/1", "POST /operations"]);
      expect(result.lastMutationIds).toEqual({ "client-1": 2 });
      expect(result.hints).toEqual([
        {
          collection: "todos",
          ids: ["1"],
          values: [],
          oldValues: [{ id: "1", value: beforeRow }],
        },
      ]);
    })
  );

  for (const status of [503, 404]) {
    it.effect(
      `a read of the refused create's row failing with HTTP ${status} fails the push, sends no resend, and a retry applies it`,
      () =>
        Effect.gen(function* () {
          // The first two requests are refused on the create (the retry's first request too),
          // so the resend happens only once the read succeeds.
          const server = makeServer(
            (request, index) =>
              index <= 1 ? rejectionAt(0, "exists") : bareWrites("atomic")(request),
            { rows: { "1": before }, readStatuses: [status] }
          );
          const backend = yield* makeModeBackend("atomic", server);
          const push = [
            mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
            mutation(2, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
          ];

          const failure = yield* Effect.flip(backend.applyMutations(context, push));
          expect(failure._tag).toBe("BackendError");
          expect(failure.message).toContain(`HTTP ${status}`);
          // The refused batch was never resent, so nothing was written and the ledger is unmoved.
          expect(sequenceOf(server)).toEqual(["POST /operations", "GET /todos/1"]);
          expect(yield* backend.lastMutationIds(context)).toEqual({});

          const result = yield* backend.applyMutations(context, push);
          expect(sequenceOf(server)).toEqual([
            "POST /operations",
            "GET /todos/1",
            "POST /operations",
            "GET /todos/1",
            "POST /operations",
          ]);
          expect(result.lastMutationIds).toEqual({ "client-1": 2 });
          expect(result.hints[0]?.oldValues).toEqual([{ id: "1", value: beforeRow }]);
        })
    );
  }

  it.effect("a refused create with no later write of its row is not read", () =>
    Effect.gen(function* () {
      const server = makeServer(refusedCreate, { rows: { "1": before } });
      const backend = yield* makeModeBackend("atomic", server);

      const result = yield* backend.applyMutations(context, [
        mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "again" } }),
        mutation(2, "todos/create", { type: "todos", id: "2", attributes: { title: "new" } }),
      ]);

      // Nothing the resend writes needs the refused row's old value, so no read can fail the push.
      expect(readsOf(server, "/todos/1")).toHaveLength(0);
      expect(sequenceOf(server)).toEqual(["POST /operations", "POST /operations"]);
      expect(result.rejected).toEqual([{ clientId: "client-1", mutationId: 1, reason: "exists" }]);
      expect(result.hints[0]?.oldValues).toBeUndefined();
    })
  );
});

/**
 * A push that writes a resource with no `getOne` route is refused before its
 * first write on either delivery path, so the writes before it are not sent (S2).
 */
describe("JsonApiBackend checks getOne for the whole push before its first write", () => {
  const mixed = HttpApi.make("app")
    .add(
      HttpApiGroup.make("todos")
        .add(HttpApiEndpoint.get("getOne", "/todos/:id", { ...idParam, success: Schema.Unknown }))
        .add(HttpApiEndpoint.post("create", "/todos", body))
    )
    .add(
      HttpApiGroup.make("notes").add(
        HttpApiEndpoint.patch("update", "/notes/:id", { ...idParam, ...body })
      )
    );

  for (const mode of ["atomic", "per-resource"] as const) {
    it.effect(
      `a write no getOne route can read sends nothing, even after an earlier write, ${mode} path`,
      () =>
        Effect.gen(function* () {
          const inspected = JsonApiSync.inspect(mixed);
          const server = makeServer(bareWrites(mode));
          const backend = yield* JsonApiBackend.make({
            baseUrl: "http://api.test",
            resources: inspected.resources,
            mutators: inspected.registry.mutators,
            operations: inspected.operations,
            ...(mode === "atomic" ? { atomic: { path: "/operations" } } : {}),
          }).pipe(Effect.provide(server.layer));

          const failure = yield* Effect.flip(
            backend.applyMutations(context, [
              mutation(1, "todos/create", { type: "todos", id: "2", attributes: { title: "new" } }),
              mutation(2, "notes/update", {
                type: "notes",
                id: "1",
                attributes: { body: "after" },
              }),
            ])
          );
          expect(failure._tag).toBe("BackendError");
          expect(failure.message).toContain('"notes" has no getOne route');
          expect(server.requests).toHaveLength(0);
          expect(yield* backend.lastMutationIds(context)).toEqual({});
        })
    );
  }
});

/** A resource that receives updates or deletes but has no `getOne` route cannot be read before a write. */
describe("JsonApiBackend without a getOne route for updated or deleted resources", () => {
  const writeOnly = HttpApi.make("app").add(
    HttpApiGroup.make("todos")
      .add(HttpApiEndpoint.patch("update", "/todos/:id", { ...idParam, ...body }))
      .add(HttpApiEndpoint.make("DELETE")("remove", "/todos/:id", idParam))
  );

  for (const mode of ["atomic", "per-resource"] as const) {
    it.effect(`an update or delete fails its push before any write, ${mode} path`, () =>
      Effect.gen(function* () {
        const inspected = JsonApiSync.inspect(writeOnly);
        const server = makeServer(bareWrites(mode));
        const backend = yield* JsonApiBackend.make({
          baseUrl: "http://api.test",
          resources: inspected.resources,
          mutators: inspected.registry.mutators,
          operations: inspected.operations,
          ...(mode === "atomic" ? { atomic: { path: "/operations" } } : {}),
        }).pipe(Effect.provide(server.layer));

        const failure = yield* Effect.flip(
          backend.applyMutations(context, [
            mutation(1, "todos/update", { type: "todos", id: "1", attributes: { title: "after" } }),
          ])
        );
        expect(failure._tag).toBe("BackendError");
        expect(failure.message).toContain('"todos" has no getOne route');
        expect(server.requests).toHaveLength(0);
        expect(yield* backend.lastMutationIds(context)).toEqual({});
      })
    );
  }

  it.effect("a resource that only receives creates needs no getOne route", () =>
    Effect.gen(function* () {
      const createOnly = HttpApi.make("app").add(
        HttpApiGroup.make("todos").add(HttpApiEndpoint.post("create", "/todos", body))
      );
      const inspected = JsonApiSync.inspect(createOnly);
      const server = makeServer(() => empty(204));
      const backend = yield* JsonApiBackend.make({
        baseUrl: "http://api.test",
        resources: inspected.resources,
        mutators: inspected.registry.mutators,
        operations: inspected.operations,
      }).pipe(Effect.provide(server.layer));
      const result = yield* backend.applyMutations(context, [
        mutation(1, "todos/create", { type: "todos", id: "1", attributes: { title: "x" } }),
      ]);
      expect(result.lastMutationIds).toEqual({ "client-1": 1 });
    })
  );
});

describe("JsonApiSync.layer atomic detection", () => {
  /** A stateful server answering both the per-resource and the atomic routes. */
  const makeStatefulServer = () => {
    const store = new Map<
      string,
      { type: string; id: string; attributes: Record<string, unknown> }
    >();
    const server = makeServer((request) => {
      if (request.method === "GET" && request.path === "/todos")
        return respond(200, { data: [...store.values()] }, jsonHeaders);
      if (request.method === "POST" && request.path === "/todos") {
        const data = request.body.data;
        store.set(data.id, { type: "todos", id: data.id, attributes: data.attributes });
        return respond(201, { data }, jsonHeaders);
      }
      if (request.method === "POST" && request.path === "/operations") {
        const ops = request.body["atomic:operations"];
        for (const op of ops) {
          if (op.op === "add")
            store.set(op.data.id, {
              type: "todos",
              id: op.data.id,
              attributes: op.data.attributes,
            });
        }
        return respond(200, resultsFor(ops));
      }
      return empty(405);
    });
    return { ...server, store };
  };
  const all = Subset.make({ collection: "todos" });
  const createAndSync = Effect.gen(function* () {
    const engine = yield* ClientEngine.ClientEngine;
    yield* engine.subscribe(all);
    yield* engine.mutate("todos/create", {
      type: "todos",
      id: "1",
      attributes: { title: "atomic" },
    });
    yield* engine.push;
    yield* engine.pull;
    return (yield* engine.query(all)).map((row) => (row.value as { title: string }).title);
  });

  it.effect("pushes through the reflected operations endpoint", () =>
    Effect.gen(function* () {
      const server = makeStatefulServer();
      const titles = yield* createAndSync.pipe(
        Effect.provide(
          JsonApiSync.layer(api, {
            baseUrl: "http://api.test",
            clientId: "client-1",
            clientGroupId: "group-1",
          }).pipe(Layer.provide(server.layer))
        )
      );
      expect(titles).toEqual(["atomic"]);
      expect(server.store.has("1")).toBe(true);
      const writes = server.requests.filter((request) => request.method === "POST");
      expect(writes.map((request) => request.path)).toEqual(["/operations"]);
    }).pipe(Effect.scoped)
  );

  it.effect("`atomic: false` keeps one request per mutation", () =>
    Effect.gen(function* () {
      const server = makeStatefulServer();
      const titles = yield* createAndSync.pipe(
        Effect.provide(
          JsonApiSync.layer(api, {
            baseUrl: "http://api.test",
            clientId: "client-1",
            clientGroupId: "group-1",
            atomic: false,
          }).pipe(Layer.provide(server.layer))
        )
      );
      expect(titles).toEqual(["atomic"]);
      const writes = server.requests.filter((request) => request.method === "POST");
      expect(writes.map((request) => request.path)).toEqual(["/todos"]);
    }).pipe(Effect.scoped)
  );
});
