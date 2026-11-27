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
import { expect, layer, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { awaitPromise } from "./await-promise.js";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { KeyValueStore } from "effect/persistence";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { BackendError, type Mutator } from "@thomasfosterau/legation";
import { BackendContract, Defined, Protocol } from "@thomasfosterau/legation/internal";
import type { EndpointRef, ResourceEndpoints, ResourceMap } from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";
import * as Ledger from "../Ledger.js";
import { flakyLedger } from "./flaky-ledger.js";

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);

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
  list: Option.some(ref(type, "list", "GET", `/${type}`)),
  getOne: Option.some(ref(type, "getOne", "GET", `/${type}/:id`)),
  create: Option.some(ref(type, "create", "POST", `/${type}`)),
  update: Option.some(ref(type, "update", "PATCH", `/${type}/:id`)),
  delete: Option.some(ref(type, "delete", "DELETE", `/${type}/:id`)),
});

const resources: ResourceMap = new Map([
  [COLLECTION, endpointsOf(COLLECTION)],
  [EVAL_COLLECTION, endpointsOf(EVAL_COLLECTION)],
]);

// ─── The server ──────────────────────────────────────────────────────────────

interface Stored {
  readonly type: string;
  readonly id: string;
  readonly attributes: Record<string, Schema.Json>;
}
type Table = MutableHashMap.MutableHashMap<string, Stored>;
type Store = MutableHashMap.MutableHashMap<string, Table>;

const tableOf = (store: Store, type: string): Table => {
  const existing = MutableHashMap.get(store, type);
  if (Option.isSome(existing)) return existing.value;
  const created: Table = MutableHashMap.empty();
  MutableHashMap.set(store, type, created);
  return created;
};

const documentOf = (row: Stored) => ({
  data: { type: row.type, id: row.id, attributes: row.attributes },
});

const respond = (status: number, document?: unknown) =>
  new Response(document === undefined ? null : encodeJson(document), {
    status,
    headers: JSON_API,
  });

/** One request as the server answers it. Reads never wait; writes run under the lock. */
interface ServerRequest {
  readonly method: string;
  readonly type: string;
  readonly id: Option.Option<string>;
  readonly body: Option.Option<{
    readonly data?: { readonly id?: string; readonly attributes?: Record<string, Schema.Json> };
  }>;
}

/** A row the server refuses to store (a permanent rejection, 422). */
const POISON = "poison";
/** A row that makes the server fall over before it stores anything (a transient failure, 500). */
const CRASH = "crash";

/** A GET: the collection, or one row (404 when absent). Reads never wait. */
const answerGet = (table: Table, id: Option.Option<string>): Response => {
  if (Option.isNone(id)) {
    return respond(200, {
      data: [...MutableHashMap.values(table)].map((row) => documentOf(row).data),
    });
  }
  const row = MutableHashMap.get(table, id.value);
  return Option.isNone(row) ? respond(404) : respond(200, documentOf(row.value));
};

/** A POST: an upsert of the row the body names, or the rejection or fault its marker asks for. */
const answerPost = (table: Table, request: ServerRequest): Response => {
  const data = Option.getOrUndefined(request.body)?.data;
  const id = data?.id ?? "";
  const attributes = data?.attributes ?? {};
  if (attributes[POISON] === true)
    return respond(422, { errors: [{ status: "422", title: "Poison row refused" }] });
  if (attributes[CRASH] === true) return respond(500);
  const row: Stored = { type: request.type, id, attributes };
  MutableHashMap.set(table, id, row);
  return respond(201, documentOf(row));
};

/**
 * A PATCH: a merge, or the count-up probe (rule 11). An `increment` update reads
 * `n`, parks at the named gate, then stores `n + 1`. The store lock keeps the
 * read and the write together, as a backend's own handler would.
 */
const answerPatch = (
  table: Table,
  row: Stored,
  request: ServerRequest,
  gates: BackendContract.ParkGates
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const attributes = Option.getOrUndefined(request.body)?.data?.attributes ?? {};
    const { increment, ...merge } = attributes;
    if (increment === undefined) {
      const updated: Stored = { ...row, attributes: { ...row.attributes, ...merge } };
      MutableHashMap.set(table, row.id, updated);
      return respond(200, documentOf(updated));
    }
    const read = Number(row.attributes.n ?? 0);
    const gate = yield* Schema.decodeUnknownEffect(Schema.String)(increment).pipe(Effect.orDie);
    yield* gates.park(gate);
    const updated: Stored = { ...row, attributes: { ...row.attributes, n: read + 1 } };
    MutableHashMap.set(table, row.id, updated);
    return respond(200, documentOf(updated));
  });

const serve = (
  store: Store,
  gates: BackendContract.ParkGates,
  request: ServerRequest
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const table = tableOf(store, request.type);
    if (request.method === "GET") return answerGet(table, request.id);
    if (request.method === "POST") return answerPost(table, request);
    const id = Option.getOrElse(request.id, () => "");
    const row = MutableHashMap.get(table, id);
    if (Option.isNone(row)) return respond(404);
    if (request.method === "DELETE") {
      MutableHashMap.remove(table, id);
      return respond(204);
    }
    return yield* answerPatch(table, row.value, request, gates);
  });

/** The server as an `HttpClient`, recording every request it serves. */
const makeInProcessClient = (store: Store) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    // The server's count-up probe parks at the gates the contract opens.
    const gates = yield* BackendContract.ParkGates;
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        requests.push({ method: request.method, path: url.pathname });
        const [, type = "", rawId] = url.pathname.split("/");
        const id = Option.map(Option.fromUndefinedOr(rawId), decodeURIComponent);
        const isWrite = request.method === "POST" || request.method === "PATCH";
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        const body = isWrite
          ? Option.some(yield* awaitPromise(() => web.json()).pipe(Effect.orDie))
          : Option.none();
        const served = serve(store, gates, { method: request.method, type, id, body });
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

const decodePutRow = Schema.decodeUnknownSync(BackendContract.putRow.args);
const decodeRowRef = Schema.decodeUnknownSync(BackendContract.delRow.args);
const decodeCountUp = Schema.decodeUnknownSync(BackendContract.countUp.args);
const decodeAttributes = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

/** Each contract mutator as one JSON:API write, the same expression the atomic contract test uses. */
const expressions: ReadonlyArray<readonly [string, (args: unknown) => JsonApiBackend.Write]> = [
  [
    BackendContract.putRow.name,
    (args) => {
      const a = decodePutRow(args);
      return {
        operation: "create",
        type: a.collection,
        id: a.id,
        attributes: decodeAttributes(a.value),
      };
    },
  ],
  [
    BackendContract.delRow.name,
    (args) => {
      const a = decodeRowRef(args);
      return { operation: "delete", type: a.collection, id: a.id };
    },
  ],
  [
    BackendContract.failAlways.name,
    () => ({
      operation: "create",
      type: COLLECTION,
      id: Protocol.RowId.make(CRASH),
      attributes: { [CRASH]: true },
    }),
  ],
  [
    BackendContract.rejectAlways.name,
    (args) => {
      const a = decodeRowRef(args);
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
      const a = decodeCountUp(args);
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
      const a = decodeRowRef(args);
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
];

/** The expressions as the backend's `writes`: none of them refuses. */
const writes = new Map<string, JsonApiBackend.Expression>(
  expressions.map(([name, express]) => [name, (args) => Result.succeed(express(args))])
);

const makeBackend = (
  options: { readonly ledger?: Ledger.LedgerStore; readonly store?: Store } = {}
) =>
  Effect.gen(function* () {
    const store: Store = options.store ?? MutableHashMap.empty();
    const { client, requests } = yield* makeInProcessClient(store);
    const backend = yield* JsonApiBackend.make({
      baseUrl: "http://contract.test",
      resources,
      mutators,
      operations: new Map(),
      writes: writes,
      // The server declares no filter or sort parameters, and the backend
      // re-applies the subset locally, so an empty query is exact over it.
      query: { encode: () => Effect.succeedSome("") },
      ...Defined.fields({ ledger: options.ledger }),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    return { backend, requests };
  });

layer(BackendContract.layerParkGates)("JsonApiBackend in per-resource mode", (it) => {
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

// ─── The ledger store across a restart ────────────────────────────────

const restartClient = "restart-client";
const restartContext = { clientGroupId: Protocol.ClientGroupId.make("restart-group") };

/** One applied create and one permanently rejected create, in order. */
const restartPush = () => [
  {
    clientId: restartClient,
    mutationId: Protocol.MutationId.make(1),
    mutator: BackendContract.putRow.name,
    args: { collection: COLLECTION, id: "kept", value: { n: 1 } },
    createdAt: 0,
  },
  {
    clientId: restartClient,
    mutationId: Protocol.MutationId.make(2),
    mutator: BackendContract.rejectAlways.name,
    args: { collection: COLLECTION, id: "poisoned" },
    createdAt: 0,
  },
];

/** A ledger's key-value store, and the gates the contract opens (the server parks at them). */
const ledgerServices = Layer.merge(KeyValueStore.layerMemory, BackendContract.layerParkGates);

describe("JsonApiBackend ledger store, per-resource mode", () => {
  layer(ledgerServices)((scoped) => {
    scoped.effect("satisfies verifyBackendContract over a durable ledger store", () =>
      Effect.gen(function* () {
        const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
        const { backend } = yield* makeBackend({ ledger });
        yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
      })
    );
  });

  layer(ledgerServices)((scoped) => {
    scoped.effect("keeps lastMutationIds and a committed rejection across a restart", () =>
      Effect.gen(function* () {
        const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
        const server: Store = MutableHashMap.empty();
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
      })
    );
  });
});

describe("JsonApiBackend ledger store failures, per-resource mode", () => {
  layer(ledgerServices)((scoped) => {
    scoped.effect(
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
          const server: Store = MutableHashMap.empty();
          const { backend, requests } = yield* makeBackend({ ledger, store: server });
          const push = [1, 2].map((mutationId) => ({
            clientId: restartClient,
            mutationId: Protocol.MutationId.make(mutationId),
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
          expect(
            Option.exists(MutableHashMap.get(server, COLLECTION), (table) =>
              MutableHashMap.has(table, "second")
            )
          ).toBe(true);
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
        })
    );
  });

  layer(ledgerServices)((scoped) => {
    scoped.effect(
      "a ledger write that fails after the server write fails the push, the store and cache agree, and a retry acknowledges",
      () =>
        Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore;
          const failWrites = yield* Ref.make(0);
          const ledger = flakyLedger(Ledger.keyValue(kv), {
            failWrites,
            failReads: yield* Ref.make(0),
          });
          const server: Store = MutableHashMap.empty();
          const { backend } = yield* makeBackend({ ledger, store: server });

          // The first mutation's write applies on the server; the ledger write that
          // acknowledges it fails, so the push fails before the second mutation is sent.
          yield* Ref.set(failWrites, 1);
          const failure = yield* Effect.flip(backend.applyMutations(restartContext, restartPush()));
          expect(failure).toBeInstanceOf(BackendError);
          expect(
            Option.exists(MutableHashMap.get(server, COLLECTION), (table) =>
              MutableHashMap.has(table, "kept")
            )
          ).toBe(true);

          // Nothing is acknowledged: the cache and the store both hold the group as it was.
          expect(yield* backend.lastMutationIds(restartContext)).toEqual({});
          expect(yield* Ledger.keyValue(kv).read(restartContext.clientGroupId)).toEqual(
            Ledger.emptyGroup
          );

          // The resend re-applies the create (an upsert) and acknowledges both mutations.
          const retried = yield* backend.applyMutations(restartContext, restartPush());
          expect((retried.rejected ?? []).map((entry) => entry.mutationId)).toEqual([2]);
          expect(retried.lastMutationIds).toEqual({ [restartClient]: 2 });
        })
    );
  });
});

// ─── The contract across a restart in the same client group ───

const sameGroup = Protocol.ClientGroupId.make("contract-same-group");
const CONTRACT_CLIENT = "contract-client";

/**
 * Runs the full contract in one client group, then restarts a backend over the
 * ledger the first run left: `restartWith` picks the store the restart reads. The
 * restarted backend has its own server tables, since the contract needs them empty.
 * The restarted run is verified with the ledgers the first run left, returned as
 * `outcome` (the restored ledger is what a restart expects), together with what
 * the restarted backend reports before the contract runs.
 */
const restartInSameGroup = (restartWith: (ledger: Ledger.LedgerStore) => Ledger.LedgerStore) =>
  Effect.gen(function* () {
    const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
    const context = { clientGroupId: sameGroup };
    const peerContext = { clientGroupId: Protocol.ClientGroupId.make(`${sameGroup}-peer`) };
    const first = yield* makeBackend({ ledger });
    yield* BackendContract.verifyBackendContract(first.backend, {
      collection: COLLECTION,
      clientGroupId: Protocol.ClientGroupId.make(sameGroup),
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
        clientGroupId: Protocol.ClientGroupId.make(sameGroup),
        restoredLedger: acknowledged[CONTRACT_CLIENT] ?? 0,
        restoredPeerLedger: peerAcknowledged[CONTRACT_CLIENT] ?? 0,
      })
    );
    return { acknowledged, rejected, restartedLedger, restartedRejected, outcome };
  });

describe("JsonApiBackend restarted on the same ledger in the same group, per-resource mode", () => {
  layer(ledgerServices)((scoped) => {
    scoped.effect(
      "runs the full contract over a backend restarted on the same durable ledger",
      () =>
        Effect.gen(function* () {
          const run = yield* restartInSameGroup((ledger) => ledger);
          expect(run.restartedLedger).toEqual(run.acknowledged);
          expect(run.restartedRejected).toEqual(run.rejected);
          expect(Exit.isSuccess(run.outcome)).toBe(true);
        })
    );
  });

  layer(ledgerServices)((scoped) => {
    scoped.effect(
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
});
