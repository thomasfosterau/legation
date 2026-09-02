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
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Atomic } from "@thomasfosterau/effect-jsonapi";
import type { Backend } from "@legation/effect";
import { ClientEngine, Subset } from "@legation/effect/internal";
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

/** An HttpClient that records every request and answers from a script. */
const makeServer = (script: (request: Recorded, index: number) => Response) => {
  const requests: Array<Recorded> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname,
        headers: { ...request.headers },
        body: readBody(request),
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(request, script(recorded, requests.length - 1));
    })
  );
  return { requests, layer: Layer.succeed(HttpClient.HttpClient)(client) };
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

describe("JsonApiBackend in atomic mode", () => {
  it.effect("pushes a three-mutation batch as one atomic:operations request", () =>
    Effect.gen(function* () {
      const server = makeServer((request) =>
        respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);

      const result = yield* backend.applyMutations(context, three);

      expect(server.requests).toHaveLength(1);
      const [request] = server.requests;
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
      const server = makeServer(() =>
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
        },
      ]);
    })
  );

  it.effect("falls back to the written value when the result carries no resource", () =>
    Effect.gen(function* () {
      const server = makeServer(() => empty(204));
      const backend = yield* makeBackend(server);
      const result = yield* backend.applyMutations(context, three);
      expect(result.lastMutationIds).toEqual({ "client-1": 3 });
      expect(result.hints[0]?.values).toEqual([
        { id: "1", value: { id: "1", title: "first" } },
        { id: "2", value: { id: "2", title: "second" } },
      ]);
    })
  );

  it.effect("resends without a permanently rejected operation and acknowledges all three", () =>
    Effect.gen(function* () {
      const server = makeServer((request, index) =>
        index === 0
          ? rejectionAt(1, "title taken")
          : respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);

      const result = yield* backend.applyMutations(context, three);

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.body["atomic:operations"]).toHaveLength(3);
      expect(server.requests[1]!.body["atomic:operations"]).toEqual([
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
        },
      ]);
    })
  );

  it.effect(
    "a pointer below the operation still names it; several rejections drop in one round trip",
    () =>
      Effect.gen(function* () {
        const server = makeServer((request, index) =>
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
        expect(server.requests).toHaveLength(2);
        expect(server.requests[1]!.body["atomic:operations"].map((op: any) => op.op)).toEqual([
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
      const server = makeServer(() => rejectionAt(0, "no"));
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
      const server = makeServer(() => empty(500));
      const backend = yield* makeBackend(server);
      const failure = yield* Effect.flip(backend.applyMutations(context, three));
      expect(failure._tag).toBe("BackendError");
      expect(failure.message).toContain("HTTP 500");
      expect(server.requests).toHaveLength(1);
      expect(yield* backend.lastMutationIds(context)).toEqual({});
    })
  );

  it.effect("a 4xx naming no operation is transient too", () =>
    Effect.gen(function* () {
      const server = makeServer(() =>
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
      const server = makeServer((_request, index) =>
        index === 0 ? rejectionAt(1, "no") : empty(503)
      );
      const backend = yield* makeBackend(server);
      const failure = yield* Effect.flip(backend.applyMutations(context, three));
      expect(failure._tag).toBe("BackendError");
      expect(server.requests).toHaveLength(2);
      expect(yield* backend.lastMutationIds(context)).toEqual({});
    })
  );

  it.effect("skips acknowledged mutations on replay and rejects gaps", () =>
    Effect.gen(function* () {
      const server = makeServer((request) =>
        respond(200, resultsFor(request.body["atomic:operations"]))
      );
      const backend = yield* makeBackend(server);
      yield* backend.applyMutations(context, [three[0]!, three[1]!]);

      const replay = yield* backend.applyMutations(context, [three[1]!, three[2]!]);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]!.body["atomic:operations"]).toEqual([
        { op: "remove", ref: { type: "todos", id: "3" } },
      ]);
      expect(replay.lastMutationIds).toEqual({ "client-1": 3 });

      // An already-acknowledged batch sends nothing at all.
      const nothing = yield* backend.applyMutations(context, three);
      expect(server.requests).toHaveLength(2);
      expect(nothing.hints).toEqual([]);

      const gap = yield* Effect.flip(
        backend.applyMutations(context, [mutation(5, "todos/delete", { type: "todos", id: "5" })])
      );
      expect(gap._tag).toBe("BackendError");
      expect(server.requests).toHaveLength(2);
      expect(yield* backend.lastMutationIds(context)).toEqual({ "client-1": 3 });
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
