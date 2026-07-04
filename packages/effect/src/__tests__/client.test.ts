/**
 * The Client facade (ADR-0022, program step 4): one object, two tiers.
 * Observing subscribes through the per-window ledger (one voice per
 * window; explicit pins survive observers); includes resolve through the
 * view's relational read with the plan's edge windows applied; Client.make
 * starts the sync loop itself; Client.connect drives a worker-hosted
 * engine over a channel with identical component-facing behavior.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Transport,
} from "../index.js";
import {
  ClientEngine,
  ClientView,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  SyncServer,
} from "../internal.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String },
  edges: { reviews: Edge.paginated("reviews", { inverse: "product", order: ["-createdAt"] }) },
});
const Review = Node.make("reviews", {
  attributes: { body: Schema.String, createdAt: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const nodes = Node.registry([Product, Review]);

const productSet = Mutator.make("product/set", Schema.Unknown);
const reviewSet = Mutator.make("review/set", Schema.Unknown);
const mutations = Mutator.registry([
  {
    mutator: productSet,
    local: (args, writer) => writer.put("products", (args as { id: string }).id, args),
  },
  {
    mutator: reviewSet,
    local: (args, writer) => writer.put("reviews", (args as { id: string }).id, args),
  },
]);

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeHandler = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(productSet, (args, writer) =>
        writer.put("products", (args as { id: string }).id, args)
      ),
      MemoryBackend.handler(reviewSet, (args, writer) =>
        writer.put("reviews", (args as { id: string }).id, args)
      ),
    ])
  );
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({
        products: Authorization.allowAll,
        reviews: Authorization.allowAll,
      })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

const makeEngine = Effect.gen(function* () {
  const handler = yield* makeHandler;
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-client");
  const engine = yield* ClientEngine.make({
    clientId: "client-facade",
    clientGroupId: "group-client",
    mutators: mutations,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return { engine, store };
});

describe("Client over an owned engine", () => {
  it.effect("observing subscribes; the ledger keeps one voice per window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const read = { collection: "products" };

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });

        // Two observers of the same read: one subscription.
        const seen = yield* Ref.make(0);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(read), () => Ref.update(seen, (n) => n + 1)).pipe(
            Effect.ignore
          )
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Stream.runForEach(client.observe(read), () => Effect.void).pipe(Effect.ignore)
            );
            yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
          })
        );
        // Inner observer ended: the outer one still holds the window.
        yield* sleepReal(50);
        expect(yield* engine.activeSubscriptions).toHaveLength(1);
        yield* eventually(Ref.get(seen), (count) => count >= 1);
      })
    )
  );

  it.effect("an explicit subscribe pins the window beyond observers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const read = { collection: "products" };

        yield* client.subscribe(read);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Stream.runForEach(client.observe(read), () => Effect.void).pipe(Effect.ignore)
            );
            yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
          })
        );
        yield* sleepReal(50);
        expect(yield* engine.activeSubscriptions).toHaveLength(1);
        yield* client.unsubscribe(read);
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 0);
      })
    )
  );

  it.effect("includes resolve with edge windows applied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        for (const [id, at] of [
          ["r-1", "2026-01-01"],
          ["r-2", "2026-03-01"],
          ["r-3", "2026-02-01"],
        ] as const) {
          yield* client.mutate("review/set", { id, body: id, createdAt: at, productId: "p-1" });
        }

        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            (rows) =>
              Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        const reviews = yield* eventually(Ref.get(latest), (rows) => rows.length === 2);
        expect(reviews.map((row) => row.id)).toEqual(["r-2", "r-3"]);
      })
    )
  );

  it.effect("Client.make starts the sync loop itself (the journal drains)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeHandler;
        const store = yield* ClientStore.makeMemory;
        const transport = yield* Transport.makeInMemory(handler, "group-auto");
        const client = yield* Client.make({
          nodes,
          mutations,
          clientId: "client-auto",
          clientGroupId: "group-auto",
          syncLoop: { pushDebounce: "10 millis" },
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, transport)
        );

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        // No push/pull calls anywhere: the auto-started loop drains it.
        yield* eventually(
          store.pendingMutations.pipe(Effect.orDie),
          (pending) => pending.length === 0
        );
      })
    )
  );
});

describe("Client.connect over a hosted engine", () => {
  it.effect("the same reads work over the channel, resolved host-side", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine, registry: nodes.collections });
        const client = yield* Client.connect({ nodes, mutations, channel: pair.mirror });

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        yield* client.mutate("review/set", {
          id: "r-1",
          body: "solid",
          createdAt: "2026-01-01",
          productId: "p-1",
        });

        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({ collection: "products", include: { reviews: { first: 5 } } }),
            (rows) => Ref.set(latest, rows)
          ).pipe(Effect.ignore)
        );
        const rows = yield* eventually(
          Ref.get(latest),
          (current) =>
            current.length === 1 &&
            ((current[0]!.related["reviews"] ?? []) as ReadonlyArray<unknown>).length === 1
        );
        expect((rows[0]!.value as { name: string }).name).toBe("Desk");
      })
    )
  );
});
