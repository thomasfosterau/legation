/**
 * Per-request backends (#681): `Backend.perRequest` builds a backend whose
 * store is acquired in a request's scope, and the sync server opens one
 * acquisition per push, pull and read (`Backend.forRequest`). The SQLite half
 * (the contract over `SqlBackend`, and a push's statements on one acquisition)
 * is in `src/__tests__/sql/backend-contract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Authorization, Backend, BackendError, MemoryBackend, Server } from "../index.js";
import { BackendContract, Subset } from "../internal.js";

/** How many acquisitions were opened and how many released. */
interface Ledger {
  readonly opened: Ref.Ref<number>;
  readonly released: Ref.Ref<number>;
}

/** A per-request backend over one shared memory store, counting its acquisitions. */
const countedOver = (shared: Backend.Backend, ledger: Ledger) =>
  Backend.perRequest(
    Effect.acquireRelease(Ref.update(ledger.opened, (n) => n + 1).pipe(Effect.as(shared)), () =>
      Ref.update(ledger.released, (n) => n + 1)
    )
  );

const makeLedger = Effect.all(
  { opened: Ref.make(0), released: Ref.make(0) },
  { concurrency: 1 }
) satisfies Effect.Effect<Ledger>;

const counts = (ledger: Ledger) =>
  Effect.all([Ref.get(ledger.opened), Ref.get(ledger.released)], { concurrency: 1 });

/** A service the acquisition below reads, provided where the backend is built. */
const Store = Context.Service<Backend.Backend>("test/PerRequestStore");

const policy = Authorization.policy({ __contract: Authorization.allowAll });

const put = (mutationId: number, id: string) => ({
  clientId: "c1",
  mutationId,
  mutator: BackendContract.putRow.name,
  args: { collection: "__contract", id, value: { id, n: mutationId } },
  createdAt: 0,
});

const everything = Subset.make({ collection: "__contract" });

describe("Backend.perRequest", () => {
  it.effect("passes verifyBackendContract over the memory backend", () =>
    Effect.gen(function* () {
      const ledger = yield* makeLedger;
      const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
      const backend = yield* countedOver(shared, ledger);
      yield* BackendContract.verifyBackendContract(backend);
      const [opened, released] = yield* counts(ledger);
      // Called directly, every call is its own acquisition, and every one is released.
      expect(opened).toBeGreaterThan(0);
      expect(released).toBe(opened);
    })
  );

  it.effect("a sync server acquires and releases it once per push, pull and read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeLedger;
        const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
        const backend = yield* countedOver(shared, ledger);
        const server = yield* Server.make({ backend, auth: { policy } });

        // Two mutations, one push: one acquisition.
        const pushed = yield* server.handler.handlePush({
          clientGroupId: "g",
          mutations: [put(1, "a"), put(2, "b")],
        });
        expect(pushed.lastMutationIds).toEqual({ c1: 2 });
        expect(yield* counts(ledger)).toEqual([1, 1]);

        // A pull reads the watermark twice, evaluates, fetches rows and reads the
        // rejections: one acquisition.
        const pulled = yield* server.handler.handlePull({
          clientGroupId: "g",
          subscriptions: [everything],
        });
        expect(pulled.patch).toHaveLength(2);
        expect(yield* counts(ledger)).toEqual([2, 2]);

        const read = yield* server.handler.handleRead({
          clientGroupId: "g",
          subsets: [everything],
        });
        expect(read.rows.map((row) => row.id)).toEqual(["a", "b"]);
        expect(yield* counts(ledger)).toEqual([3, 3]);
      })
    )
  );

  it.effect("concurrent requests get separate acquisitions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
        const opened = yield* Ref.make(0);
        const live = yield* Ref.make(0);
        const bothOpen = yield* Deferred.make<void>();
        // Each acquisition is held open until two are open at once, so the two pulls
        // finish only if each got its own.
        const backend = yield* Backend.perRequest(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Ref.update(opened, (n) => n + 1);
              if ((yield* Ref.updateAndGet(live, (n) => n + 1)) === 2) {
                yield* Deferred.succeed(bothOpen, undefined);
              }
              yield* Deferred.await(bothOpen);
              return shared;
            }),
            () => Ref.update(live, (n) => n - 1)
          )
        );
        const server = yield* Server.make({ backend, auth: { policy } });
        const pull = (clientGroupId: string) =>
          server.handler.handlePull({ clientGroupId, subscriptions: [everything] });
        const [first, second] = yield* Effect.all([pull("g1"), pull("g2")], {
          concurrency: "unbounded",
        });
        expect(first.patch).toEqual([]);
        expect(second.patch).toEqual([]);
        expect(yield* Ref.get(opened)).toBe(2);
        expect(yield* Ref.get(live)).toBe(0);
      })
    )
  );

  it.effect("a failed acquisition fails the push, which applies nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
        const backend = yield* Backend.perRequest(
          Effect.fail(new BackendError({ message: "no connection" }))
        );
        const server = yield* Server.make({ backend, auth: { policy } });
        const failure = yield* Effect.flip(
          server.handler.handlePush({ clientGroupId: "g", mutations: [put(1, "a")] })
        );
        expect(failure.message).toBe("no connection");
        expect(yield* shared.lastMutationIds({ clientGroupId: "g" })).toEqual({});
      })
    )
  );

  it.effect("captures the services its acquisition needs where it is built", () =>
    Effect.gen(function* () {
      const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
      const backend = yield* Backend.perRequest(Effect.service(Store)).pipe(
        Effect.provideService(Store, shared)
      );
      expect(yield* backend.lastMutationIds({ clientGroupId: "g" })).toEqual({});
    })
  );

  it.effect("forRequest hands a plain backend, or a copy of a per-request one, back as it is", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeLedger;
        const shared = yield* MemoryBackend.make(BackendContract.memoryHandlers);
        expect(yield* Backend.forRequest(shared)).toBe(shared);
        const backend = yield* countedOver(shared, ledger);
        const copy: Backend.Backend = { ...backend };
        expect(yield* Backend.forRequest(copy)).toBe(copy);
        expect(yield* Backend.forRequest(backend)).toBe(shared);
        expect(yield* counts(ledger)).toEqual([1, 0]);
      })
    )
  );
});
