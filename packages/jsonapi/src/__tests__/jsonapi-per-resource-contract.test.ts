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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { KeyValueStore } from "effect/persistence";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BackendError, type Mutator } from "@thomasfosterau/legation-effect";
import { BackendContract } from "@thomasfosterau/legation-effect/internal";
import type { EndpointRef, ResourceEndpoints, ResourceMap } from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";
import * as Ledger from "../Ledger.js";
import { flakyLedger } from "./flaky-ledger.js";

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

const makeBackend = (
  options: { readonly ledger?: Ledger.LedgerStore; readonly store?: Store } = {}
) =>
  Effect.gen(function* () {
    const store: Store = options.store ?? new Map();
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
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
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

// ─── The ledger store across a restart (#468) ────────────────────────────────

const restartClient = "restart-client";
const restartContext = { clientGroupId: "restart-group" };

/** One applied create and one permanently rejected create, in order. */
const restartPush = () => [
  {
    clientId: restartClient,
    mutationId: 1,
    mutator: BackendContract.putRow.name,
    args: { collection: COLLECTION, id: "kept", value: { n: 1 } },
    createdAt: 0,
  },
  {
    clientId: restartClient,
    mutationId: 2,
    mutator: BackendContract.rejectAlways.name,
    args: { collection: COLLECTION, id: "poisoned" },
    createdAt: 0,
  },
];

describe("JsonApiBackend ledger store (#468), per-resource mode", () => {
  it.effect("satisfies verifyBackendContract over a durable ledger store", () =>
    Effect.gen(function* () {
      const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      const { backend } = yield* makeBackend({ ledger });
      yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("keeps lastMutationIds and a committed rejection across a restart", () =>
    Effect.gen(function* () {
      const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      const server: Store = new Map();
      const first = yield* makeBackend({ ledger, store: server });
      const pushed = yield* first.backend.applyMutations(restartContext, restartPush());
      const rejected = pushed.rejected ?? [];
      expect(rejected.map((entry) => entry.mutationId)).toEqual([2]);

      // A restart: a new backend over the same ledger store and the same server.
      const second = yield* makeBackend({ ledger, store: server });
      expect(yield* second.backend.lastMutationIds(restartContext)).toEqual({
        [restartClient]: 2,
      });
      expect(yield* second.backend.rejections(restartContext)).toEqual(rejected);

      // A replayed copy is acknowledged: nothing is sent, and the stored rejection is reported.
      const replay = yield* second.backend.applyMutations(restartContext, restartPush());
      expect(replay.rejected).toEqual(rejected);
      expect(second.requests.filter((request) => request.method !== "GET")).toEqual([]);
      expect(replay.lastMutationIds).toEqual({ [restartClient]: 2 });
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("JsonApiBackend ledger store failures (#468), per-resource mode", () => {
  it.effect(
    "a ledger write that fails after the second write keeps the first acknowledged, and the resend re-applies the second",
    () =>
      Effect.gen(function* () {
        const durable = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
        // Each mutation's write applies on the server and is then acknowledged by one
        // ledger write. The first ledger write goes through, and the second fails.
        const ledgerWrites = yield* Ref.make(0);
        const ledger: Ledger.LedgerStore = {
          read: durable.read,
          write: (clientGroupId, group) =>
            Ref.updateAndGet(ledgerWrites, (n) => n + 1).pipe(
              Effect.flatMap((n) =>
                n === 2
                  ? Effect.fail(new BackendError({ message: "Ledger write failed" }))
                  : durable.write(clientGroupId, group)
              )
            ),
        };
        const server: Store = new Map();
        const { backend, requests } = yield* makeBackend({ ledger, store: server });
        const push = [1, 2].map((mutationId) => ({
          clientId: restartClient,
          mutationId,
          mutator: BackendContract.putRow.name,
          args: {
            collection: COLLECTION,
            id: mutationId === 1 ? "first" : "second",
            value: { n: mutationId },
          },
          createdAt: 0,
        }));

        const failure = yield* Effect.flip(backend.applyMutations(restartContext, push));
        expect(failure).toBeInstanceOf(BackendError);
        // Both writes reached the server. Mutation 1 is acknowledged in the cache and the
        // store; mutation 2 is not, because its acknowledgement write failed.
        expect(server.get(COLLECTION)?.has("second")).toBe(true);
        expect(yield* backend.lastMutationIds(restartContext)).toEqual({ [restartClient]: 1 });
        expect(yield* durable.read(restartContext.clientGroupId)).toEqual({
          lastMutationIds: { [restartClient]: 1 },
          rejections: [],
        });

        // The resend skips mutation 1, re-applies mutation 2 (one write), and acknowledges both.
        const sentBefore = requests.filter((request) => request.method !== "GET").length;
        const retried = yield* backend.applyMutations(restartContext, push);
        const sentAfter = requests.filter((request) => request.method !== "GET").length;
        expect(sentAfter - sentBefore).toBe(1);
        expect(retried.lastMutationIds).toEqual({ [restartClient]: 2 });
        expect(yield* durable.read(restartContext.clientGroupId)).toEqual({
          lastMutationIds: { [restartClient]: 2 },
          rejections: [],
        });
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "a ledger write that fails after the server write fails the push, the store and cache agree, and a retry acknowledges",
    () =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        const failWrites = yield* Ref.make(0);
        const ledger = flakyLedger(Ledger.keyValue(kv), {
          failWrites,
          failReads: yield* Ref.make(0),
        });
        const server: Store = new Map();
        const { backend } = yield* makeBackend({ ledger, store: server });

        // The first mutation's write applies on the server; the ledger write that
        // acknowledges it fails, so the push fails before the second mutation is sent.
        yield* Ref.set(failWrites, 1);
        const failure = yield* Effect.flip(backend.applyMutations(restartContext, restartPush()));
        expect(failure).toBeInstanceOf(BackendError);
        expect(server.get(COLLECTION)?.has("kept")).toBe(true);

        // Nothing is acknowledged: the cache and the store both hold the group as it was.
        expect(yield* backend.lastMutationIds(restartContext)).toEqual({});
        expect(yield* Ledger.keyValue(kv).read(restartContext.clientGroupId)).toEqual(
          Ledger.emptyGroup
        );

        // The resend re-applies the create (an upsert) and acknowledges both mutations.
        const retried = yield* backend.applyMutations(restartContext, restartPush());
        expect((retried.rejected ?? []).map((entry) => entry.mutationId)).toEqual([2]);
        expect(retried.lastMutationIds).toEqual({ [restartClient]: 2 });
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );
});

// ─── The contract across a restart in the same client group (#477, #483) ───

const sameGroup = "contract-same-group";
const CONTRACT_CLIENT = "contract-client";

/**
 * Runs the full contract in one client group, then restarts a backend over the
 * ledger the first run left: `restartWith` picks the store the restart reads. The
 * restarted backend has its own server tables, since the contract needs them empty.
 * The restarted run is verified with the ledgers the first run left, returned as
 * `outcome` (the restored ledger is what a restart expects, #483), together with what
 * the restarted backend reports before the contract runs.
 */
const restartInSameGroup = (restartWith: (ledger: Ledger.LedgerStore) => Ledger.LedgerStore) =>
  Effect.gen(function* () {
    const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
    const context = { clientGroupId: sameGroup };
    const peerContext = { clientGroupId: `${sameGroup}-peer` };
    const first = yield* makeBackend({ ledger });
    yield* BackendContract.verifyBackendContract(first.backend, {
      collection: COLLECTION,
      clientGroupId: sameGroup,
    });
    const acknowledged = yield* first.backend.lastMutationIds(context);
    const peerAcknowledged = yield* first.backend.lastMutationIds(peerContext);
    const rejected = yield* first.backend.rejections(context);
    expect(acknowledged[CONTRACT_CLIENT]).toBeGreaterThan(0);
    expect(peerAcknowledged[CONTRACT_CLIENT]).toBeGreaterThan(0);

    const restarted = yield* makeBackend({ ledger: restartWith(ledger) });
    const restartedLedger = yield* restarted.backend.lastMutationIds(context);
    const restartedRejected = yield* restarted.backend.rejections(context);
    const outcome = yield* Effect.exit(
      BackendContract.verifyBackendContract(restarted.backend, {
        collection: COLLECTION,
        clientGroupId: sameGroup,
        restoredLedger: acknowledged[CONTRACT_CLIENT] ?? 0,
        restoredPeerLedger: peerAcknowledged[CONTRACT_CLIENT] ?? 0,
      })
    );
    return { acknowledged, rejected, restartedLedger, restartedRejected, outcome };
  }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory));

describe("JsonApiBackend restarted on the same ledger in the same group (#477, #483), per-resource mode", () => {
  it.effect("runs the full contract over a backend restarted on the same durable ledger", () =>
    Effect.gen(function* () {
      const run = yield* restartInSameGroup((ledger) => ledger);
      expect(run.restartedLedger).toEqual(run.acknowledged);
      expect(run.restartedRejected).toEqual(run.rejected);
      expect(Exit.isSuccess(run.outcome)).toBe(true);
    })
  );

  it.effect(
    "fails a backend that forgets its ledger on restart through the restored-ledger rule",
    () =>
      Effect.gen(function* () {
        // Ledger.memory reads an empty group: the restarted backend reports {} where the
        // restored run expects the ids the first run acknowledged, so the contract fails
        // its first rule and never reaches the mutations.
        const run = yield* restartInSameGroup(() => Ledger.memory);
        expect(run.restartedLedger).toEqual({});
        const violation = Option.getOrUndefined(Exit.findErrorOption(run.outcome));
        expect(violation).toBeInstanceOf(BackendContract.ContractViolation);
        expect(violation?.rule).toBe("reports the ledger the run expects");
        expect(violation?.message).toContain("the backend forgot its ledger on restart");
      })
  );
});
