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
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { KeyValueStore } from "effect/persistence";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
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
import { BackendError, type Backend, type Mutator } from "@thomasfosterau/legation-effect";
import { BackendContract, Subset } from "@thomasfosterau/legation-effect/internal";
import * as Convention from "../Convention.js";
import * as JsonApiBackend from "../JsonApiBackend.js";
import * as Ledger from "../Ledger.js";
import { flakyLedger } from "./flaky-ledger.js";
import { defined } from "./defined.js";

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
  /**
   * The count-up probe (rule 11): the server reads `n`, parks at the named gate,
   * then stores `n + 1`. Never stored: it names the gate for this one update.
   */
  increment: Schema.optionalKey(Schema.String),
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

/**
 * Test-only server behaviour for the visibility probe (#381). `holds` parks a
 * batch after it has staged the row with that id, until the probe releases it.
 * `publishEarly` is the broken server the probe must catch: it copies a staged
 * row into the committed store at once, instead of at the batch's commit.
 */
interface Hold {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
interface ServerProbe {
  readonly holds: ReadonlyMap<string, Hold>;
  readonly publishEarly: boolean;
}
const noProbe: ServerProbe = { holds: new Map(), publishEarly: false };

/** `add`: honour the client id recovered from the raw document; apply the two server rules. */
const applyAdd = (
  staged: Store,
  committed: Store,
  probe: ServerProbe,
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
  if (row.attributes.poison === true)
    return Effect.fail(rejection(index, "poison rows are refused"));
  // Staged before the crash check: a row written and then crashed must be
  // discarded with the batch, not leaked into the committed store.
  tableOf(staged, row.type).set(id, row);
  if (row.attributes.crash === true) return Effect.die(new Error("the server fell over"));
  return Effect.gen(function* () {
    if (probe.publishEarly) tableOf(committed, row.type).set(id, row);
    const hold = probe.holds.get(id);
    if (hold !== undefined) {
      yield* Deferred.succeed(hold.entered, undefined);
      yield* Deferred.await(hold.release);
    }
    return { data: resourceOf(row) };
  });
};

/**
 * `update`: merge attributes over an existing row. An `increment` attribute
 * instead reads `n` from the staged row, parks at the gate it names, and stores
 * `n + 1` (the count-up probe, rule 11). The gate sits between the read and the
 * write, as a backend's own handler would park.
 */
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
  const { increment, ...merge } = operation.data.attributes ?? {};
  if (increment === undefined) {
    const row: Stored = { ...current, attributes: { ...current.attributes, ...merge } };
    tableOf(staged, row.type).set(id, row);
    return Effect.succeed({ data: resourceOf(row) });
  }
  return Effect.gen(function* () {
    const read = Number(current.attributes.n ?? 0);
    yield* BackendContract.park(increment);
    const row: Stored = { ...current, attributes: { ...current.attributes, n: read + 1 } };
    tableOf(staged, row.type).set(id, row);
    return { data: resourceOf(row) };
  });
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
  committed: Store,
  probe: ServerProbe,
  index: number,
  operation: BatchOperation,
  clientId: string | undefined
): Effect.Effect<Entry, Rejection> => {
  switch (operation.op) {
    case "add":
      return applyAdd(staged, committed, probe, index, operation, clientId);
    case "update":
      return applyUpdate(staged, index, operation);
    case "remove":
      return applyRemove(staged, index, operation);
  }
};

/**
 * `lock` serialises whole batches: a batch copies the store, runs, and commits
 * over it, so two overlapping batches would lose the first one's writes. One
 * batch at a time is the store-wide lock that meets guarantee 1 (#353).
 */
const operationsLive = (store: Store, lock: Semaphore.Semaphore, probe: ServerProbe) =>
  HttpApiBuilder.group(api, "operations", (handlers) =>
    handlers.handle("operations", ({ payload, request }) =>
      Effect.gen(function* () {
        // The request body is cached, so it can be re-read after decoding.
        const raw = (yield* request.json.pipe(Effect.orDie)) as {
          readonly "atomic:operations": ReadonlyArray<{ readonly data?: { readonly id?: string } }>;
        };
        const staged: Store = new Map([...store].map(([type, rows]) => [type, new Map(rows)]));
        const entries: Array<Entry> = [];
        yield* Effect.forEach(
          payload["atomic:operations"].entries(),
          ([index, operation]) =>
            Effect.gen(function* () {
              const clientId = raw["atomic:operations"][index]?.data?.id;
              entries.push(yield* applyOperation(staged, store, probe, index, operation, clientId));
            }),
          { concurrency: 1, discard: true }
        );
        // Commit.
        store.clear();
        Arr.forEach(staged, ([type, rows]) => {
          store.set(type, rows);
        });
        return Atomic.results(entries);
      }).pipe(Semaphore.withPermits(lock, 1))
    )
  );

/** The whole api as a web handler, and an `HttpClient` that calls it in-process. */
const makeInProcessClient = (store: Store, probe: ServerProbe = noProbe) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const middleware = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] });
    // effect-jsonapi 0.12's `:id` endpoint declarations leak an `unknown`
    // requirement into their handlers (see examples/commerce/server/client.ts);
    // the runtime carries nothing, so narrow it here.
    const app = HttpApiBuilder.layer(api).pipe(
      Layer.provide(
        Layer.mergeAll(
          rowsLive(store),
          evalRowsLive(store),
          operationsLive(store, lock, probe)
        ).pipe(Layer.provide(middleware))
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
    BackendContract.writeThenFail,
    BackendContract.countUp,
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
  [
    BackendContract.countUp.name,
    (args) => {
      const a = args as { collection: string; id: string; gate: string };
      // An update the server turns into the increment (see applyUpdate).
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
      // The server stages the row before it falls over (see applyAdd), so the
      // staged write must be discarded with the batch.
      return {
        operation: "create",
        type: a.collection,
        id: a.id,
        attributes: { n: 99, crash: true },
      };
    },
  ],
]);

/** A copy of `map` without `key`. */
const without = <V>(map: ReadonlyMap<string, V>, key: string) =>
  new Map([...map].filter(([name]) => name !== key));

/**
 * What a test may hand the backend besides the default: its ledger store (#468),
 * and the server's tables, so a backend restarted over the same server keeps them.
 */
interface BackendOptions {
  readonly ledger?: Ledger.LedgerStore;
  readonly store?: Store;
}

/**
 * The JSON:API backend under test. `omitted` leaves one contract mutator out of
 * both the decode and the write maps, as a backend that never registered it.
 */
const makeBackend = (
  omitted?: string,
  probe: ServerProbe = noProbe,
  options: BackendOptions = {}
) =>
  Effect.gen(function* () {
    const store: Store = options.store ?? new Map();
    const { client, requests } = yield* makeInProcessClient(store, probe);
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
      mutators: omitted === undefined ? mutators : without(mutators, omitted),
      operations: new Map(),
      writes: omitted === undefined ? writes : without(writes, omitted),
      atomic: { path: defined(atomic).path },
      // The server declares no filter/sort parameters (its list endpoint is the
      // whole table); the backend re-applies the subset locally anyway, so an
      // empty query is exact over this server.
      query: { encode: () => Effect.succeed(Option.some("")) },
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    return { backend, requests, store };
  });

describe("JsonApiBackend in atomic mode against effect-jsonapi's Endpoint.operations", () => {
  it.effect("satisfies verifyBackendContract", () =>
    Effect.gen(function* () {
      const { backend, requests } = yield* makeBackend();
      yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
      // Every write went through the atomic endpoint; reads through the resources.
      const writeRequests = requests.filter((request) => request.method !== "GET");
      expect(writeRequests.length).toBeGreaterThan(0);
      expect(writeRequests.every((request) => request.path === "/operations")).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect("catches an unregistered write-then-fail mutator", () =>
    Effect.gen(function* () {
      const { backend } = yield* makeBackend(BackendContract.writeThenFail.name);
      const failure = yield* Effect.flip(
        BackendContract.verifyBackendContract(backend, { collection: COLLECTION })
      );
      expect(failure.rule).toContain("discards");
      expect(failure.message).toContain("not registered");
    }).pipe(Effect.scoped)
  );

  it("reflects the effect-jsonapi api without a phantom `operations` resource", () => {
    const resources = Convention.reflectResources(api);
    expect([...resources.keys()].toSorted()).toEqual([COLLECTION, EVAL_COLLECTION]);
    expect(resources.get(COLLECTION)?.getOne?.path).toBe(`/${COLLECTION}/:id`);
    expect(resources.get(COLLECTION)?.create).toBeUndefined();
  });
});

// ─── Visibility before the bump (guarantee 1, #381) ──────────────────────────

const probeContext = { clientGroupId: "visibility-group" };
const probeClient = "visibility-client";
const heldRow = "held";

/** What a concurrent reader sees: the row, the evaluated subset and the ledger. */
const readView = (backend: Backend.Backend) =>
  Effect.gen(function* () {
    const rows = (yield* backend.getRows(probeContext, COLLECTION, [heldRow])).map(
      (row) => row.value
    );
    const entries = yield* backend.evaluate(probeContext, Subset.make({ collection: COLLECTION }));
    const ledger = yield* backend.lastMutationIds(probeContext);
    return { rows, entries, ledger };
  });

/**
 * Pushes one create whose server batch parks after staging its row. A concurrent
 * read is taken while it is parked (the server's lock is held, but reads are not
 * behind it), then the batch is released and read again.
 */
const probeBatch = (publishEarly: boolean) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { backend } = yield* makeBackend(undefined, {
      holds: new Map([[heldRow, { entered, release }]]),
      publishEarly,
    });
    const push = yield* Effect.forkChild(
      backend.applyMutations(probeContext, [
        {
          clientId: probeClient,
          mutationId: 1,
          mutator: BackendContract.putRow.name,
          args: { collection: COLLECTION, id: heldRow, value: { n: 1 } },
          createdAt: 0,
        },
      ])
    );
    yield* Deferred.await(entered);
    const parked = yield* readView(backend).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.ignore))
    );
    const result = yield* Fiber.join(push);
    return { parked, committed: yield* readView(backend), reported: result.lastMutationIds };
  }).pipe(Effect.scoped);

/** The guarantee: a parked batch's row and bump are invisible to a concurrent reader. */
const expectInvisibleWhileParked = (parked: {
  readonly rows: ReadonlyArray<unknown>;
  readonly entries: ReadonlyArray<unknown>;
  readonly ledger: Readonly<Record<string, number>>;
}) => {
  expect(parked.rows).toEqual([]);
  expect(parked.entries).toEqual([]);
  expect(parked.ledger).toEqual({});
};

describe("JsonApiBackend visibility before the bump (guarantee 1, #381)", () => {
  it.effect("a concurrent read sees neither a parked batch's row nor its bump", () =>
    Effect.gen(function* () {
      const observed = yield* probeBatch(false);
      expectInvisibleWhileParked(observed.parked);
    })
  );

  it.effect("the row and the bump are both visible once the batch commits", () =>
    Effect.gen(function* () {
      const observed = yield* probeBatch(false);
      expect(observed.reported).toEqual({ [probeClient]: 1 });
      expect(observed.committed.rows).toEqual([expect.objectContaining({ n: 1 })]);
      expect(observed.committed.entries).toEqual([expect.objectContaining({ id: heldRow })]);
      expect(observed.committed.ledger).toEqual({ [probeClient]: 1 });
    })
  );

  // Mutation: a server that publishes each staged row at once. The probe must
  // see the row (and so the subset) while the batch is parked. The ledger stays
  // empty: the client acknowledges only after the server's response.
  it.effect(
    "leaks the staged row, and only the row, from a server that publishes before commit (mutation)",
    () =>
      Effect.gen(function* () {
        const observed = yield* probeBatch(true);
        expect(observed.parked.rows).toEqual([expect.objectContaining({ n: 1 })]);
        expect(observed.parked.entries).toEqual([expect.objectContaining({ id: heldRow })]);
        expect(observed.parked.ledger).toEqual({});
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

describe("JsonApiBackend ledger store (#468), atomic mode", () => {
  it.effect("satisfies verifyBackendContract over a durable ledger store", () =>
    Effect.gen(function* () {
      const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      const { backend } = yield* makeBackend(undefined, noProbe, { ledger });
      yield* BackendContract.verifyBackendContract(backend, { collection: COLLECTION });
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("keeps lastMutationIds and a committed rejection across a restart", () =>
    Effect.gen(function* () {
      const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
      const server: Store = new Map();
      const first = yield* makeBackend(undefined, noProbe, { ledger, store: server });
      const pushed = yield* first.backend.applyMutations(restartContext, restartPush());
      const rejected = pushed.rejected ?? [];
      expect(rejected.map((entry) => entry.mutationId)).toEqual([2]);

      // A restart: a new backend over the same ledger store and the same server.
      const second = yield* makeBackend(undefined, noProbe, { ledger, store: server });
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

// ─── Ledger store failures and the forgetting bound (#468) ───────────────────

describe("JsonApiBackend ledger store failures (#468), atomic mode", () => {
  it.effect(
    "a ledger write that fails after the server write fails the push, the store and cache agree, and a retry acknowledges",
    () =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore;
        const failWrites = yield* Ref.make(0);
        const failReads = yield* Ref.make(0);
        const ledger = flakyLedger(Ledger.keyValue(kv), { failWrites, failReads });
        const server: Store = new Map();
        const { backend } = yield* makeBackend(undefined, noProbe, { ledger, store: server });

        // The batch's rejection is remembered by the first ledger write, which runs
        // after the server has applied the batch's create.
        yield* Ref.set(failWrites, 1);
        const failure = yield* Effect.flip(backend.applyMutations(restartContext, restartPush()));
        expect(failure).toBeInstanceOf(BackendError);
        expect(tableOf(server, COLLECTION).has("kept")).toBe(true);

        // Nothing is acknowledged: the cache and the store both hold the group as it was.
        expect(yield* backend.lastMutationIds(restartContext)).toEqual({});
        expect(yield* backend.rejections(restartContext)).toEqual([]);
        expect(yield* kv.has("legation-jsonapi:ledger:restart-group")).toBe(false);

        // The resend re-applies the create (an upsert) and acknowledges both mutations.
        const retried = yield* backend.applyMutations(restartContext, restartPush());
        const rejected = retried.rejected ?? [];
        expect(rejected.map((entry) => entry.mutationId)).toEqual([2]);
        expect(retried.lastMutationIds).toEqual({ [restartClient]: 2 });
        expect(yield* Ledger.keyValue(kv).read(restartContext.clientGroupId)).toEqual({
          lastMutationIds: { [restartClient]: 2 },
          rejections: rejected,
        });
        expect(yield* backend.rejections(restartContext)).toEqual(rejected);
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("a ledger read that fails is a BackendError and fills no cache", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const durable = Ledger.keyValue(kv);
      // Seed the store with a ledger that a backend over it must read back.
      const seeded = yield* makeBackend(undefined, noProbe, { ledger: durable, store: new Map() });
      yield* seeded.backend.applyMutations(restartContext, restartPush());

      const failReads = yield* Ref.make(1);
      const ledger = flakyLedger(durable, { failWrites: yield* Ref.make(0), failReads });
      const { backend } = yield* makeBackend(undefined, noProbe, { ledger, store: new Map() });
      const failure = yield* Effect.flip(backend.lastMutationIds(restartContext));
      expect(failure).toBeInstanceOf(BackendError);
      // The failed read cached nothing, so the next read reaches the store and sees its ledger.
      expect(yield* backend.lastMutationIds(restartContext)).toEqual({ [restartClient]: 2 });
      expect(yield* backend.rejections(restartContext)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("the forgetting bound persists across a restart", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const ledger = Ledger.keyValue(kv);
      const server: Store = new Map();
      const first = yield* makeBackend(undefined, noProbe, { ledger, store: server });
      const mutation = (mutationId: number, mutator: string, args: unknown) => ({
        clientId: restartClient,
        mutationId,
        mutator,
        args,
        createdAt: 0,
      });
      const putOne = mutation(1, BackendContract.putRow.name, {
        collection: COLLECTION,
        id: "first",
        value: { n: 1 },
      });
      const rejectTwo = mutation(2, BackendContract.rejectAlways.name, {
        collection: COLLECTION,
        id: "poisoned",
      });
      const putThree = mutation(3, BackendContract.putRow.name, {
        collection: COLLECTION,
        id: "third",
        value: { n: 3 },
      });
      // Mutation 2 is rejected and remembered; the push acknowledges up to 3.
      yield* first.backend.applyMutations(restartContext, [putOne, rejectTwo, putThree]);
      expect(yield* first.backend.rejections(restartContext)).toHaveLength(1);
      // A replayed copy of 3 alone has floor 3, so it forgets the rejection of 2. Nothing
      // else changes, so the forgetting is the only ledger write this push makes.
      const replay = yield* first.backend.applyMutations(restartContext, [putThree]);
      expect(replay.rejected).toBeUndefined();
      expect(yield* first.backend.rejections(restartContext)).toEqual([]);

      // After a restart the forgetting is kept, and a replayed copy of 2 is acknowledged, not reported.
      const second = yield* makeBackend(undefined, noProbe, { ledger, store: server });
      expect(yield* second.backend.rejections(restartContext)).toEqual([]);
      expect(yield* second.backend.lastMutationIds(restartContext)).toEqual({ [restartClient]: 3 });
      const replayRejected = yield* second.backend.applyMutations(restartContext, [rejectTwo]);
      expect(replayRejected.rejected).toBeUndefined();
      expect(second.requests.filter((request) => request.method !== "GET")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "restarts over the same durable store with the first group's ledger, and runs the contract in a fresh group",
    () =>
      Effect.gen(function* () {
        const ledger = Ledger.keyValue(yield* KeyValueStore.KeyValueStore);
        // The first run uses one group, and its ledger is what a restart must bring back.
        // The restarted backend runs the contract in another group; the same group is the
        // restart test below (#477).
        const firstContext = { clientGroupId: "contract-first" };
        const first = yield* makeBackend(undefined, noProbe, { ledger });
        yield* BackendContract.verifyBackendContract(first.backend, {
          collection: COLLECTION,
          clientGroupId: firstContext.clientGroupId,
        });
        const acknowledged = yield* first.backend.lastMutationIds(firstContext);
        const rejected = yield* first.backend.rejections(firstContext);
        expect(Object.keys(acknowledged)).not.toHaveLength(0);
        expect(rejected).not.toHaveLength(0);

        // The restart: a new backend over the same durable store reports the group it left.
        const restarted = yield* makeBackend(undefined, noProbe, { ledger });
        expect(yield* restarted.backend.lastMutationIds(firstContext)).toEqual(acknowledged);
        expect(yield* restarted.backend.rejections(firstContext)).toEqual(rejected);

        // The restarted backend then runs the contract in another group.
        yield* BackendContract.verifyBackendContract(restarted.backend, {
          collection: COLLECTION,
          clientGroupId: "contract-restarted",
        });
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
    const first = yield* makeBackend(undefined, noProbe, { ledger });
    yield* BackendContract.verifyBackendContract(first.backend, {
      collection: COLLECTION,
      clientGroupId: sameGroup,
    });
    const acknowledged = yield* first.backend.lastMutationIds(context);
    const peerAcknowledged = yield* first.backend.lastMutationIds(peerContext);
    const rejected = yield* first.backend.rejections(context);
    expect(acknowledged[CONTRACT_CLIENT]).toBeGreaterThan(0);
    expect(peerAcknowledged[CONTRACT_CLIENT]).toBeGreaterThan(0);

    const restarted = yield* makeBackend(undefined, noProbe, { ledger: restartWith(ledger) });
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

describe("JsonApiBackend restarted on the same ledger in the same group (#477, #483), atomic mode", () => {
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
