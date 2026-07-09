/**
 * Sync world — Northwind Traders
 *
 * The real library pipeline in the page (`SyncServer` + `MemoryBackend` +
 * `CvrStore` + `InvalidationBus`) over a durable `localStorage` store and an
 * offline-aware loopback transport. Reads are public (an internal admin tool),
 * so there's no identity/auth layer — the focus is multi-collection relational
 * sync and optimistic edits.
 *
 * Two mutators read before they write (`product/update`, `order/ship`): the
 * grid sends only the changed fields, and the handler — on both the client
 * overlay and the authoritative backend — looks the current row up via
 * `writer.get`, merges, and puts. That re-runs idempotently on every rebase.
 */

import { Effect, Fiber, Layer, ManagedRuntime, Schema, Stream, SubscriptionRef } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
  TransportError,
  type VersionNotSupportedError,
} from "@legation/effect";
import {
  ClientEngine,
  ClientView,
  Cvr,
  InvalidationBus,
  SyncServer,
} from "@legation/effect/internal";
import { Runtime } from "@legation/svelte";

import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  Category,
  Customer,
  Employee,
  Order,
  OrderDetail,
  Product,
  type ProductPatchType,
  Supplier,
  allSubsets,
  createCategory,
  createCustomer,
  createEmployee,
  createOrder,
  createOrderDetail,
  createProduct,
  createSupplier,
  deleteProduct,
  shipOrder,
  updateProduct,
} from "./domain";
import * as seed from "./seed";

export interface World {
  readonly runtime: Runtime.EffectSyncRuntime;
  readonly setOnline: (online: boolean) => Promise<void>;
  readonly subscribeConnection: (
    listener: (status: Transport.ConnectionStatus) => void
  ) => () => void;
}

// ─── Client mutator handlers (optimistic overlay) ────────────────────────────

const clientMutators = Mutator.registry([
  {
    mutator: updateProduct,
    local: (a: ProductPatchType, w) =>
      Effect.flatMap(w.get("products", a.id), (existing) =>
        existing === undefined
          ? Effect.void
          : w.put("products", a.id, {
              ...(existing as Product),
              unitPrice: a.unitPrice,
              unitsInStock: a.unitsInStock,
              discontinued: a.discontinued,
            })
      ),
  },
  { mutator: createProduct, local: (a: Product, w) => w.put("products", a.id, a) },
  { mutator: deleteProduct, local: (a: { id: string }, w) => w.del("products", a.id) },
  { mutator: createCategory, local: (a: Category, w) => w.put("categories", a.id, a) },
  {
    mutator: shipOrder,
    local: (a: { id: string; shippedAt: number }, w) =>
      Effect.flatMap(w.get("orders", a.id), (existing) =>
        existing === undefined
          ? Effect.void
          : w.put("orders", a.id, { ...(existing as Order), shippedAt: a.shippedAt })
      ),
  },
]);

// ─── Backend handlers (authoritative) ────────────────────────────────────────

const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(updateProduct, (a, w) =>
    Effect.flatMap(w.get("products", a.id), (existing) =>
      existing === undefined
        ? Effect.void
        : w.put("products", a.id, {
            ...(existing as Product),
            unitPrice: a.unitPrice,
            unitsInStock: a.unitsInStock,
            discontinued: a.discontinued,
          })
    )
  ),
  MemoryBackend.handler(createProduct, (a, w) => w.put("products", a.id, a)),
  MemoryBackend.handler(deleteProduct, (a, w) => w.del("products", a.id)),
  MemoryBackend.handler(createCategory, (a, w) => w.put("categories", a.id, a)),
  MemoryBackend.handler(shipOrder, (a, w) =>
    Effect.flatMap(w.get("orders", a.id), (existing) =>
      existing === undefined
        ? Effect.void
        : w.put("orders", a.id, { ...(existing as Order), shippedAt: a.shippedAt })
    )
  ),
  // Seed-only create handlers for the remaining entities.
  MemoryBackend.handler(createSupplier, (a, w) => w.put("suppliers", a.id, a)),
  MemoryBackend.handler(createCustomer, (a, w) => w.put("customers", a.id, a)),
  MemoryBackend.handler(createEmployee, (a, w) => w.put("employees", a.id, a)),
  MemoryBackend.handler(createOrder, (a, w) => w.put("orders", a.id, a)),
  MemoryBackend.handler(createOrderDetail, (a, w) => w.put("orderDetails", a.id, a)),
]);

const authPolicy = Authorization.policy({
  categories: Authorization.allowAll,
  suppliers: Authorization.allowAll,
  products: Authorization.allowAll,
  customers: Authorization.allowAll,
  employees: Authorization.allowAll,
  orders: Authorization.allowAll,
  orderDetails: Authorization.allowAll,
});

// ─── Offline-aware loopback transport ────────────────────────────────────────

const makeOfflineTransport = (
  handler: Transport.ServerHandler,
  online: SubscriptionRef.SubscriptionRef<boolean>
): Transport.ClientTransport => {
  const whenOnline = <A>(
    effect: Effect.Effect<A, TransportError | VersionNotSupportedError>
  ): Effect.Effect<A, TransportError | VersionNotSupportedError> =>
    SubscriptionRef.get(online).pipe(
      Effect.flatMap((on) =>
        on ? effect : Effect.fail(new TransportError({ message: "Client is offline" }))
      )
    );
  return {
    push: (request) => whenOnline(handler.handlePush(request)),
    pull: (request) => whenOnline(handler.handlePull(request)),
    pokes: handler.pokes(CLIENT_GROUP_ID),
    status: SubscriptionRef.get(online).pipe(
      Effect.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
    statusChanges: SubscriptionRef.changes(online).pipe(
      Stream.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
  };
};

// ─── Seed ────────────────────────────────────────────────────────────────────

const seedBackend = (backend: Backend.Backend, bus: InvalidationBus.InvalidationBus) =>
  Effect.gen(function* () {
    let seq = 0;
    const apply = (mutator: string, args: unknown) =>
      Effect.gen(function* () {
        seq += 1;
        const result = yield* backend.applyMutations({ clientGroupId: "seed" }, [
          { clientId: "seed", mutationId: seq, mutator, args, createdAt: Date.now() },
        ]);
        yield* bus.publish(result.hints);
      });
    for (const row of seed.categories) yield* apply("category/create", Schema.encodeSync(Category)(row));
    for (const row of seed.suppliers) yield* apply("supplier/create", Schema.encodeSync(Supplier)(row));
    for (const row of seed.products) yield* apply("product/create", Schema.encodeSync(Product)(row));
    for (const row of seed.customers) yield* apply("customer/create", Schema.encodeSync(Customer)(row));
    for (const row of seed.employees) yield* apply("employee/create", Schema.encodeSync(Employee)(row));
    for (const row of seed.orders) yield* apply("order/create", Schema.encodeSync(Order)(row));
    for (const row of seed.orderDetails)
      yield* apply("orderDetail/create", Schema.encodeSync(OrderDetail)(row));
  });

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export const createWorld = (): Promise<World> =>
  new Promise<World>((resolve, reject) => {
    const program = Effect.gen(function* () {
      const online = yield* SubscriptionRef.make(true);

      const backend = yield* MemoryBackend.make(backendHandlers);
      const cvr = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, authPolicy),
        Effect.provideService(Cvr.CvrStore, cvr),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      yield* seedBackend(backend, bus);

      const transport = makeOfflineTransport(handler, online);
      const store = yield* ClientStore.makeKeyValue({ prefix: "svelte-northwind/" }).pipe(
        Effect.provide(BrowserKeyValueStore.layerLocalStorage)
      );
      const engine = yield* ClientEngine.make({
        clientId: CLIENT_ID,
        clientGroupId: CLIENT_GROUP_ID,
        mutators: clientMutators,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );

      for (const subset of allSubsets) yield* engine.subscribe(subset);
      yield* engine.runSync;

      const runtime: Runtime.EffectSyncRuntime = ManagedRuntime.make(
        Layer.succeed(ClientEngine.ClientEngine, engine).pipe(
          Layer.merge(Layer.succeed(ClientView.ClientView)(ClientView.fromEngine(engine)))
        )
      );

      const world: World = {
        runtime,
        setOnline: (next) => Effect.runPromise(SubscriptionRef.set(online, next)),
        subscribeConnection: (listener) => {
          const fiber = Effect.runFork(
            Stream.runForEach(transport.statusChanges, (status) =>
              Effect.sync(() => listener(status))
            )
          );
          void Effect.runPromise(transport.status).then(listener);
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        },
      };

      yield* Effect.sync(() => resolve(world));
      yield* Effect.never;
    });

    Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.catchCause((cause) => Effect.sync(() => reject(new Error(String(cause)))))
      )
    );
  });
