/**
 * JsonApiBackend contract test, per-resource mode
 *
 * `BackendContract.verifyBackendContract` over `JsonApiBackend` with no atomic
 * endpoint: every write is one JSON:API request (`POST`, `PATCH` or `DELETE`)
 * to an in-process server that keeps the same two tables as the atomic contract
 * test (`jsonapi-atomic-contract.test.ts`). The server answers `POST` as an
 * upsert, as that test's atomic `add` does, so the contract's `put` (which
 * rewrites an existing row) works on this path too. Each `POST` and `PATCH` runs
 * under one store-wide lock, so a count-up update cannot interleave with another
 * write. A `GET` or `DELETE` has no yield point, so it runs whole without it.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Semaphore } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { Mutator } from "@thomasfosterau/legation-effect";
import { BackendContract } from "@thomasfosterau/legation-effect/internal";
import type { EndpointRef, ResourceEndpoints, ResourceMap } from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";

const COLLECTION = "contract";
const EVAL_COLLECTION = `${COLLECTION}_eval`;
const JSON_API = { "Content-Type": "application/vnd.api+json" };

// ─── The routes ──────────────────────────────────────────────────────────────

const ref = (groupId: string, name: string, method: string, path: string): EndpointRef => ({
  groupId,
  name,
  method,
  path,
});

/** The CRUD routes of one collection, as the reflected api would name them. */
const endpointsOf = (type: string): ResourceEndpoints => ({
  type,
  list: ref(type, "list", "GET", `/${type}`),
  getOne: ref(type, "getOne", "GET", `/${type}/:id`),
  create: ref(type, "create", "POST", `/${type}`),
  update: ref(type, "update", "PATCH", `/${type}/:id`),
  delete: ref(type, "delete", "DELETE", `/${type}/:id`),
});

const resources: ResourceMap = new Map([
  [COLLECTION, endpointsOf(COLLECTION)],
  [EVAL_COLLECTION, endpointsOf(EVAL_COLLECTION)],
]);

// ─── The server ──────────────────────────────────────────────────────────────

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, unknown>;
}
type Table = Map<string, Stored>;
type Store = Map<string, Table>;

const tableOf = (store: Store, type: string): Table => {
  const existing = store.get(type);
  if (existing !== undefined) return existing;
  const created: Table = new Map();
  store.set(type, created);
  return created;
};

const documentOf = (row: Stored) => ({
  data: { type: row.type, id: row.id, attributes: row.attributes },
});

const respond = (status: number, document?: unknown) =>
  new Response(document === undefined ? null : JSON.stringify(document), {
    status,
    headers: JSON_API,
  });

/** One request as the server answers it. Reads never wait; writes run under the lock. */
interface ServerRequest {
  readonly method: string;
  readonly type: string;
  readonly id: string | undefined;
  readonly body:
    | { readonly data?: { readonly id?: string; readonly attributes?: Record<string, unknown> } }
    | undefined;
}

/** A row the server refuses to store (a permanent rejection, 422). */
const POISON = "poison";
/** A row that makes the server fall over before it stores anything (a transient failure, 500). */
const CRASH = "crash";

/** A GET: the collection, or one row (404 when absent). Reads never wait. */
const answerGet = (table: Table, id: string | undefined): Response => {
  if (id === undefined) {
    return respond(200, { data: [...table.values()].map((row) => documentOf(row).data) });
  }
  const row = table.get(id);
  return row === undefined ? respond(404) : respond(200, documentOf(row));
};

/** A POST: an upsert of the row the body names, or the rejection or fault its marker asks for. */
const answerPost = (table: Table, request: ServerRequest): Response => {
  const id = request.body?.data?.id ?? "";
  const attributes = request.body?.data?.attributes ?? {};
  if (attributes[POISON] === true)
    return respond(422, { errors: [{ status: "422", title: "Poison row refused" }] });
  if (attributes[CRASH] === true) return respond(500);
  const row: Stored = { type: request.type, id, attributes };
  table.set(id, row);
  return respond(201, documentOf(row));
};

/**
 * A PATCH: a merge, or the count-up probe (rule 11). An `increment` update reads
 * `n`, parks at the named gate, then stores `n + 1`. The store lock keeps the
 * read and the write together, as a backend's own handler would.
 */
const answerPatch = (table: Table, row: Stored, request: ServerRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const attributes = request.body?.data?.attributes ?? {};
    const { increment, ...merge } = attributes;
    if (increment === undefined) {
      const updated: Stored = { ...row, attributes: { ...row.attributes, ...merge } };
      table.set(row.id, updated);
      return respond(200, documentOf(updated));
    }
    const read = Number(row.attributes.n ?? 0);
    yield* BackendContract.park(String(increment));
    const updated: Stored = { ...row, attributes: { ...row.attributes, n: read + 1 } };
    table.set(row.id, updated);
    return respond(200, documentOf(updated));
  });

const serve = (store: Store, request: ServerRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const table = tableOf(store, request.type);
    if (request.method === "GET") return answerGet(table, request.id);
    if (request.method === "POST") return answerPost(table, request);
    const id = request.id ?? "";
    const row = table.get(id);
    if (row === undefined) return respond(404);
    if (request.method === "DELETE") {
      table.delete(id);
      return respond(204);
    }
    return yield* answerPatch(table, row, request);
  });

/** The server as an `HttpClient`, recording every request it serves. */
const makeInProcessClient = (store: Store) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        requests.push({ method: request.method, path: url.pathname });
        const [, type = "", rawId] = url.pathname.split("/");
        const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
        const isWrite = request.method === "POST" || request.method === "PATCH";
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        const body = isWrite ? yield* Effect.promise(() => web.json()) : undefined;
        const served = serve(store, { method: request.method, type, id, body });
        const response =
          request.method === "GET" || request.method === "DELETE"
            ? yield* served
            : yield* served.pipe(Semaphore.withPermits(lock, 1));
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
    BackendContract.writeThenFail,
    BackendContract.countUp,
  ].map((mutator) => [mutator.name, mutator])
);

/** Each contract mutator as one JSON:API write, the same expression the atomic contract test uses. */
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
    () => ({ operation: "create", type: COLLECTION, id: CRASH, attributes: { [CRASH]: true } }),
  ],
  [
    BackendContract.rejectAlways.name,
    (args) => {
      const a = args as { collection: string; id: string };
      return {
        operation: "create",
        type: a.collection,
        id: a.id,
        attributes: { [POISON]: true },
      };
    },
  ],
  [
    BackendContract.countUp.name,
    (args) => {
      const a = args as { collection: string; id: string; gate: string };
      return {
        operation: "update",
        type: a.collection,
        id: a.id,
        attributes: { increment: a.gate },
      };
    },
  ],
  [
    BackendContract.writeThenFail.name,
    (args) => {
      const a = args as { collection: string; id: string };
      // The server stores nothing for a request it answers with 500, so the
      // write is discarded with the request.
      return {
        operation: "create",
        type: a.collection,
        id: a.id,
        attributes: { n: 99, [CRASH]: true },
      };
    },
  ],
]);

const makeBackend = () =>
  Effect.gen(function* () {
    const store: Store = new Map();
    const { client, requests } = yield* makeInProcessClient(store);
    const backend = yield* JsonApiBackend.make({
      baseUrl: "http://contract.test",
      resources,
      mutators,
      operations: new Map(),
      writes,
      // The server declares no filter or sort parameters, and the backend
      // re-applies the subset locally, so an empty query is exact over it.
      query: { encode: () => Effect.succeed(Option.some("")) },
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    return { backend, requests };
  });

describe("JsonApiBackend in per-resource mode", () => {
  it.effect("satisfies verifyBackendContract", () =>
    Effect.gen(function* () {
      const { backend, requests } = yield* makeBackend();
      yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
      // Every write went to its resource, none through an atomic endpoint.
      const writeRequests = requests.filter((request) => request.method !== "GET");
      expect(writeRequests.length).toBeGreaterThan(0);
      expect(writeRequests.some((request) => request.path === "/operations")).toBe(false);
    })
  );
});
