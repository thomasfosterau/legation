/**
 * Sync world — Northwind Traders
 *
 * The real library pipeline in the page — `Server` (the one server-side
 * object: the protocol handler plus `broadcast`, with in-memory CVR storage
 * and an in-process fan-out bus by default) over a `MemoryBackend`, reached
 * through a loopback transport behind a simulated-offline gate, with a durable
 * `localStorage` client store. Reads are public (an internal admin tool), so
 * there's no identity/auth layer — the focus is multi-collection relational
 * sync and optimistic edits.
 *
 * It is assembled as a `Layer` and run by a `ManagedRuntime`: the runtime owns
 * the scope, so the forked sync loop lives exactly as long as the app does.
 *
 * Two mutations read before they write (`product/update`, `order/ship`): the
 * grid sends only the changed fields, and the handler — on both the client
 * overlay and the authoritative backend — looks the current row up via
 * `writer.get`, merges, and puts. That re-runs idempotently on every rebase.
 */

import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  MemoryBackend,
  Mutation,
  Server,
  Transport,
} from "@legation/effect";
// The engine is built explicitly rather than through `Client.make`: the
// devtools core (#120) is an engine-level capability, and `Client.make` does
// not hand the engine back. `Client.fromView` wraps it — the same Client.
import { ClientEngine, ClientView } from "@legation/effect/internal";
import { Runtime } from "@legation/svelte";
import * as Devtools from "@legation/devtools";

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
  createCategory,
  createCustomer,
  createEmployee,
  createOrder,
  createOrderDetail,
  createProduct,
  createSupplier,
  deleteProduct,
  nodes,
  shellReads,
  shipOrder,
  updateProduct,
} from "./domain";
import * as seed from "./seed";

export interface World {
  readonly runtime: Runtime.ClientRuntime;
  /** The `@legation/devtools` headless core (#120) over this engine + store. */
  readonly devtools: Devtools.DevtoolsCore;
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Connection status: the current value now, then every change. */
  readonly connection: Stream.Stream<Transport.ConnectionStatus>;
}

// ─── Client mutator handlers (optimistic overlay) ────────────────────────────

const clientMutations = Mutation.registry([
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

// ─── Seed ────────────────────────────────────────────────────────────────────

const seedBackend = (backend: Backend.Backend): Effect.Effect<void> =>
  Effect.gen(function* () {
    let seq = 0;
    const apply = (mutator: string, args: unknown) =>
      Effect.gen(function* () {
        seq += 1;
        yield* backend.applyMutations({ clientGroupId: "seed" }, [
          { clientId: "seed", mutationId: seq, mutator, args, createdAt: Date.now() },
        ]);
      });
    for (const row of seed.categories) yield* apply("category/create", Schema.encodeSync(Category)(row));
    for (const row of seed.suppliers) yield* apply("supplier/create", Schema.encodeSync(Supplier)(row));
    for (const row of seed.products) yield* apply("product/create", Schema.encodeSync(Product)(row));
    for (const row of seed.customers) yield* apply("customer/create", Schema.encodeSync(Customer)(row));
    for (const row of seed.employees) yield* apply("employee/create", Schema.encodeSync(Employee)(row));
    for (const row of seed.orders) yield* apply("order/create", Schema.encodeSync(Order)(row));
    for (const row of seed.orderDetails)
      yield* apply("orderDetail/create", Schema.encodeSync(OrderDetail)(row));
  }).pipe(Effect.orDie);

// ─── The rig: the Client, plus what the shell's own controls reach for ───────

interface Rig {
  readonly client: Client.Client;
  readonly devtools: Devtools.DevtoolsCore;
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly connection: Stream.Stream<Transport.ConnectionStatus>;
}
const Rig = Context.Service<Rig>("northwind/Rig");

const rigLayer = Layer.effect(Rig)(
  Effect.gen(function* () {
    // Server side: the one server-side object over the demo backend. CVR
    // storage and the fan-out bus default to in-memory/in-process.
    const backend = yield* MemoryBackend.make(backendHandlers);
    const server = yield* Server.make({ backend, auth: { policy: authPolicy } });
    yield* seedBackend(backend);

    // A loopback transport behind a simulated-offline gate (the devtools'
    // offline action drives the same toggle, #120) + a durable store.
    const loopback = yield* Transport.makeInMemory(server.handler, CLIENT_GROUP_ID);
    const { transport, setOffline, isOffline } = yield* Transport.simulateOffline(loopback);
    const store = yield* ClientStore.makeKeyValue({ prefix: "northwind/" }).pipe(
      Effect.provide(BrowserKeyValueStore.layerLocalStorage)
    );

    const engine = yield* ClientEngine.make({
      clientId: CLIENT_ID,
      clientGroupId: CLIENT_GROUP_ID,
      mutators: clientMutations,
      // Both legs are opt-in: without `pushDebounce` a journaled mutation
      // waits for a reconnect, a poke, or an explicit push, so an online
      // client would sit on unflushed edits. `pullInterval` is the
      // correctness backstop for when no poke arrives.
      syncLoop: { pushDebounce: "300 millis", pullInterval: "15 seconds" },
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    yield* Effect.forkScoped(engine.runSync.pipe(Effect.orDie));

    const client = Client.fromView(nodes, ClientView.fromEngine(engine));
    // Pin every collection for the tab's lifetime: a screen's `include` only
    // resolves against rows this client has actually synced.
    yield* Effect.forEach(shellReads, (read) => client.subscribe(read), { discard: true }).pipe(
      Effect.orDie
    );

    return {
      client,
      // The devtools headless core (#120): the offline control is the same
      // `simulateOffline` toggle the banner's own button drives.
      devtools: Devtools.make(engine, store, { offline: { setOffline, isOffline } }),
      setOffline,
      connection: Stream.concat(Stream.fromEffect(transport.status), transport.statusChanges),
    };
  })
);

/**
 * The app layer: the rig, plus the `Client` the rune hooks resolve from
 * context. `provideMerge` keeps both services on one build of the rig.
 */
const appLayer = Layer.effect(Client.Client)(Effect.map(Rig, (rig) => rig.client)).pipe(
  Layer.provideMerge(rigLayer)
);

/** Build the world. The `ManagedRuntime` owns the scope for the app's life. */
export const createWorld = async (): Promise<World> => {
  const runtime = ManagedRuntime.make(appLayer);
  const rig = await runtime.runPromise(Rig);
  return {
    runtime,
    devtools: rig.devtools,
    setOnline: (next) => runtime.runPromise(rig.setOffline(!next)),
    connection: rig.connection,
  };
};
