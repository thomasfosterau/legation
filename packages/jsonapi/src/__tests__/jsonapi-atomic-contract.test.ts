/**
 * JsonApiBackend contract test, atomic mode
 *
 * `BackendContract.verifyBackendContract` over `JsonApiBackend` pushing to a
 * real effect-jsonapi server: `Endpoint.operations` behind `HttpApiBuilder`
 * over an in-memory table, served in-process through a web handler that the
 * backend reaches as an `HttpClient`. The contract's own mutators (`put`,
 * `del`, `fail`, `reject`) are expressed as JSON:API writes through the
 * backend's `writes` seam; the server's rules make `reject` a 422 pointing at
 * the operation and `fail` a server fault (500).
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  ApiError,
  Atomic,
  Document,
  Endpoint,
  Group,
  Handlers,
  Middleware,
  Resource,
} from "@thomasfosterau/effect-jsonapi";
import type { Mutator } from "@legation/effect";
import { BackendContract } from "@legation/effect/internal";
import * as Convention from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";

// ─── The api ─────────────────────────────────────────────────────────────────

const COLLECTION = "contract";
const EVAL_COLLECTION = `${COLLECTION}_eval`;

// One attribute set covers everything the contract writes: `n` (rows),
// `rank`/`tag` (subset evaluation, whose generated corpus writes NULL and
// absent values under ADR-0028, so both are nullable and optional), plus the
// two server rules below.
const attributes = {
  n: Schema.optionalKey(Schema.Number),
  rank: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A row the server refuses to store: a permanent rejection (422). */
  poison: Schema.optionalKey(Schema.Boolean),
  /** A row that makes the server fall over: a transient failure (500). */
  crash: Schema.optionalKey(Schema.Boolean),
};
const Row = Resource.make(COLLECTION, { attributes });
const EvalRow = Resource.make(EVAL_COLLECTION, { attributes });
type Attributes = (typeof Row.Type)["attributes"];
type AnyResource = typeof Row.Type | typeof EvalRow.Type;

class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  title: "Resource not found",
}) {}

/**
 * A 422 whose error objects point at the failed operation (`source.pointer`),
 * as the extension recommends. `ApiError.make` has no `source` member, so the
 * error is declared structurally: any `{ wire, status }` is an `ErrorClass`.
 */
const OperationRejected = {
  status: 422,
  wire: Document.ErrorDocument().pipe(HttpApiSchema.status(422)),
};
type Rejection = (typeof OperationRejected.wire)["Type"];
const rejection = (index: number, detail: string): Rejection => ({
  errors: [
    {
      status: "422",
      title: "Operation rejected",
      detail,
      source: { pointer: Atomic.operationPointer(index) },
    },
  ],
});

const readOnly = {
  endpoints: { create: false, update: false, delete: false },
  relationships: false,
  include: false,
  fields: false,
  sort: false,
  errors: [NotFound],
} as const;

const api = HttpApi.make("contract")
  .add(Group.make(Row, ...Endpoint.resource(Row, readOnly)))
  .add(Group.make(EvalRow, ...Endpoint.resource(EvalRow, readOnly)))
  .add(
    Group.make("operations", Endpoint.operations([Row, EvalRow], { errors: [OperationRejected] }))
  );

// ─── The server ──────────────────────────────────────────────────────────────

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}
type Store = Map<string, Map<string, Stored>>;

const tableOf = (store: Store, type: string): Map<string, Stored> => {
  const existing = store.get(type);
  if (existing !== undefined) return existing;
  const created = new Map<string, Stored>();
  store.set(type, created);
  return created;
};

const contractResource = (row: Stored): typeof Row.Type => ({
  type: COLLECTION,
  id: Row.Id.make(row.id),
  attributes: row.attributes as Attributes,
});
const evalResource = (row: Stored): typeof EvalRow.Type => ({
  type: EVAL_COLLECTION,
  id: EvalRow.Id.make(row.id),
  attributes: row.attributes as Attributes,
});
const resourceOf = (row: Stored): AnyResource =>
  row.type === COLLECTION ? contractResource(row) : evalResource(row);

const rowsLive = (store: Store) =>
  HttpApiBuilder.group(api, COLLECTION, (handlers) =>
    handlers
      .handle("list", () =>
        Effect.succeed(
          Handlers.collection([...tableOf(store, COLLECTION).values()].map(contractResource))
        )
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const row = tableOf(store, COLLECTION).get(params.id);
          if (row === undefined) return yield* new NotFound();
          return Handlers.data(contractResource(row));
        })
      )
  );

const evalRowsLive = (store: Store) =>
  HttpApiBuilder.group(api, EVAL_COLLECTION, (handlers) =>
    handlers
      .handle("list", () =>
        Effect.succeed(
          Handlers.collection([...tableOf(store, EVAL_COLLECTION).values()].map(evalResource))
        )
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const row = tableOf(store, EVAL_COLLECTION).get(params.id);
          if (row === undefined) return yield* new NotFound();
          return Handlers.data(evalResource(row));
        })
      )
  );

/**
 * The atomic operations handler: every operation is applied to a staged copy
 * of the store and the copy is committed only when all of them succeed —
 * all-or-nothing, as the extension requires.
 *
 * Two deliberate leniencies, both noted: effect-jsonapi's typed `add`
 * operation carries no `id` member (it expects the server to assign one), so
 * this server recovers the client-generated id from the raw request document
 * and honours it; and an `add` whose id already exists replaces the row
 * rather than answering 409, so the contract's `put` (an upsert) can be an
 * `add`.
 */
type Entry = { readonly data?: AnyResource };
type BatchOperation = Atomic.Operation<typeof Row | typeof EvalRow>["Type"];

/** `add`: honour the client id recovered from the raw document; apply the two server rules. */
const applyAdd = (
  staged: Store,
  index: number,
  operation: Extract<BatchOperation, { readonly op: "add" }>,
  id: string | undefined
): Effect.Effect<Entry, Rejection> => {
  if (id === undefined) return Effect.fail(rejection(index, "add without a client-generated id"));
  const row: Stored = {
    type: operation.data.type,
    id,
    attributes: operation.data.attributes as Record<string, unknown>,
  };
  if (row.attributes.crash === true) return Effect.die(new Error("the server fell over"));
  if (row.attributes.poison === true)
    return Effect.fail(rejection(index, "poison rows are refused"));
  tableOf(staged, row.type).set(id, row);
  return Effect.succeed({ data: resourceOf(row) });
};

/** `update`: merge attributes over an existing row. */
const applyUpdate = (
  staged: Store,
  index: number,
  operation: Extract<BatchOperation, { readonly op: "update" }>
): Effect.Effect<Entry, Rejection> => {
  const id = operation.data.id;
  const current = id === undefined ? undefined : tableOf(staged, operation.data.type).get(id);
  if (id === undefined || current === undefined) {
    return Effect.fail(rejection(index, "no such row to update"));
  }
  const row: Stored = {
    ...current,
    attributes: { ...current.attributes, ...operation.data.attributes },
  };
  tableOf(staged, row.type).set(id, row);
  return Effect.succeed({ data: resourceOf(row) });
};

/** `remove`: by id only. */
const applyRemove = (
  staged: Store,
  index: number,
  operation: Extract<BatchOperation, { readonly op: "remove" }>
): Effect.Effect<Entry, Rejection> => {
  if (!("id" in operation.ref)) {
    return Effect.fail(rejection(index, "remove by lid is unsupported"));
  }
  tableOf(staged, operation.ref.type).delete(operation.ref.id);
  return Effect.succeed({});
};

const applyOperation = (
  staged: Store,
  index: number,
  operation: BatchOperation,
  clientId: string | undefined
): Effect.Effect<Entry, Rejection> => {
  switch (operation.op) {
    case "add":
      return applyAdd(staged, index, operation, clientId);
    case "update":
      return applyUpdate(staged, index, operation);
    case "remove":
      return applyRemove(staged, index, operation);
  }
};

const operationsLive = (store: Store) =>
  HttpApiBuilder.group(api, "operations", (handlers) =>
    handlers.handle("operations", ({ payload, request }) =>
      Effect.gen(function* () {
        // The request body is cached, so it can be re-read after decoding.
        const raw = (yield* request.json.pipe(Effect.orDie)) as {
          readonly "atomic:operations": ReadonlyArray<{ readonly data?: { readonly id?: string } }>;
        };
        const staged: Store = new Map([...store].map(([type, rows]) => [type, new Map(rows)]));
        const entries: Array<Entry> = [];
        for (const [index, operation] of payload["atomic:operations"].entries()) {
          const clientId = raw["atomic:operations"][index]?.data?.id;
          entries.push(yield* applyOperation(staged, index, operation, clientId));
        }
        // Commit.
        store.clear();
        for (const [type, rows] of staged) store.set(type, rows);
        return Atomic.results(entries);
      })
    )
  );

/** The whole api as a web handler, and an `HttpClient` that calls it in-process. */
const makeInProcessClient = (store: Store) =>
  Effect.gen(function* () {
    const middleware = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] });
    // effect-jsonapi 0.12's `:id` endpoint declarations leak an `unknown`
    // requirement into their handlers (see examples/commerce/server/client.ts);
    // the runtime carries nothing, so narrow it here.
    const app = HttpApiBuilder.layer(api).pipe(
      Layer.provide(
        Layer.mergeAll(rowsLive(store), evalRowsLive(store), operationsLive(store)).pipe(
          Layer.provide(middleware)
        )
      ),
      Layer.provide(middleware),
      Layer.provide(HttpServer.layerServices)
    ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
    const { handler } = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose)
    );
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        requests.push({ method: request.method, path: url.pathname });
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        const response = yield* Effect.promise(() => handler(web));
        return HttpClientResponse.fromWeb(request, response);
      })
    );
    return { client, requests };
  });

// ─── The backend under test ──────────────────────────────────────────────────

/** The contract mutators, for decoding pushed args. */
const mutators = new Map<string, Mutator.AnyMutator>(
  [
    BackendContract.putRow,
    BackendContract.delRow,
    BackendContract.failAlways,
    BackendContract.rejectAlways,
  ].map((mutator) => [mutator.name, mutator])
);

/**
 * Each contract mutator as one JSON:API write. `put` is an upsert, so it is an
 * `add` with the client-generated id (the server above replaces on conflict);
 * `fail` and `reject` trip the server's `crash` / `poison` rules.
 */
const writes = new Map<string, (args: unknown) => JsonApiBackend.Write>([
  [
    BackendContract.putRow.name,
    (args) => {
      const a = args as { collection: string; id: string; value: unknown };
      return {
        operation: "create",
        type: a.collection,
        id: a.id,
        attributes: a.value as Record<string, unknown>,
      };
    },
  ],
  [
    BackendContract.delRow.name,
    (args) => {
      const a = args as { collection: string; id: string };
      return { operation: "delete", type: a.collection, id: a.id };
    },
  ],
  [
    BackendContract.failAlways.name,
    () => ({ operation: "create", type: COLLECTION, id: "crash", attributes: { crash: true } }),
  ],
  [
    BackendContract.rejectAlways.name,
    (args) => {
      const a = args as { collection: string; id: string };
      return { operation: "create", type: a.collection, id: a.id, attributes: { poison: true } };
    },
  ],
]);

const makeBackend = Effect.gen(function* () {
  const store: Store = new Map();
  const { client, requests } = yield* makeInProcessClient(store);
  const atomic = Convention.reflectAtomic(api);
  // oxlint-disable-next-line vitest/no-standalone-expect -- runs inside every test that builds the backend
  expect(atomic).toEqual({
    groupId: "operations",
    name: "operations",
    method: "POST",
    path: "/operations",
  });
  const backend = yield* JsonApiBackend.make({
    baseUrl: "http://contract.test",
    resources: Convention.reflectResources(api),
    mutators,
    operations: new Map(),
    writes,
    atomic: { path: atomic!.path },
    // The server declares no filter/sort parameters (its list endpoint is the
    // whole table); the backend re-applies the subset locally anyway, so an
    // empty query is exact over this server.
    query: { encode: () => Effect.succeed(Option.some("")) },
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  return { backend, requests, store };
});

describe("JsonApiBackend in atomic mode against effect-jsonapi's Endpoint.operations", () => {
  it.effect("satisfies verifyBackendContract", () =>
    Effect.gen(function* () {
      const { backend, requests } = yield* makeBackend;
      yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
      // Every write went through the atomic endpoint; reads through the resources.
      const writeRequests = requests.filter((request) => request.method !== "GET");
      expect(writeRequests.length).toBeGreaterThan(0);
      expect(writeRequests.every((request) => request.path === "/operations")).toBe(true);
    }).pipe(Effect.scoped)
  );

  it("reflects the effect-jsonapi api without a phantom `operations` resource", () => {
    const resources = Convention.reflectResources(api);
    expect([...resources.keys()].toSorted()).toEqual([COLLECTION, EVAL_COLLECTION]);
    expect(resources.get(COLLECTION)?.getOne?.path).toBe(`/${COLLECTION}/:id`);
    expect(resources.get(COLLECTION)?.create).toBeUndefined();
  });
});
