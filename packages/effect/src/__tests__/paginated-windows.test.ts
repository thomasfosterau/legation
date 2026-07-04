/**
 * Paginated-edge sync windows (ADR-0024, program step 5): a paginated
 * edge's `first` registers one windowed subset per parent row, so the
 * replica syncs the window — not the dependent collection. Registration
 * follows parents entering and leaving the root window; a newer child
 * shifts the window on the next poke-driven pull; the same read works over
 * a hosted engine, windows crossing the mirror protocol.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import {
  Authorization,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Server,
  Transport,
} from "../index.js";
import { ClientEngine, ClientView, EngineHost, MirrorChannel, Subset } from "../internal.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String, featured: Schema.Boolean },
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

const makeServer = Effect.gen(function* () {
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
  const server = yield* Server.make({
    backend,
    auth: {
      policy: Authorization.policy({
        products: Authorization.allowAll,
        reviews: Authorization.allowAll,
      }),
    },
  });
  return { backend, server };
});

const makeEngine = (handler: Transport.ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStore.makeMemory;
    const transport = yield* Transport.makeInMemory(handler, group);
    const engine = yield* ClientEngine.make({
      clientId: `client-${group}`,
      clientGroupId: group,
      mutators: mutations,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    return engine;
  });

/** The windowed review subsets among an engine's active subscriptions. */
const reviewWindows = (subs: ReadonlyArray<Subset.Subset>) =>
  subs.filter((subset) => subset.collection === "reviews" && subset.limit !== undefined);

const seedReviews = (
  client: Client.Client,
  productId: string,
  entries: ReadonlyArray<readonly [string, string]>
) =>
  Effect.forEach(
    entries,
    ([id, at]) => client.mutate("review/set", { id, body: id, createdAt: at, productId }),
    { discard: true }
  );

describe("per-parent windowed subsets", () => {
  it.effect("an included paginated edge registers one windowed subset per parent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;
        const engine = yield* makeEngine(server.handler, "group-reg");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        for (const id of ["p-1", "p-2"]) {
          yield* client.mutate("product/set", { id, name: id, featured: true });
        }
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            () => Effect.void
          ).pipe(Effect.ignore)
        );

        // One windowed subset per parent, carrying the edge's order + limit.
        const subs = yield* eventually(
          engine.activeSubscriptions,
          (all) => reviewWindows(all).length === 2
        );
        for (const window of reviewWindows(subs)) {
          expect(window.limit).toBe(2);
          expect(window.orderBy).toEqual([{ field: "createdAt", direction: "desc" }]);
          expect(window.where._tag).toBe("Compare");
        }
      })
    )
  );

  it.effect("the replica syncs the window, not the dependent collection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;

        // A writer group seeds five reviews authoritatively.
        const writerEngine = yield* makeEngine(server.handler, "group-writer");
        const writer = Client.fromView(nodes, ClientView.fromEngine(writerEngine));
        yield* writer.mutate("product/set", { id: "p-1", name: "Desk", featured: true });
        yield* seedReviews(writer, "p-1", [
          ["r-1", "2026-01-01"],
          ["r-2", "2026-02-01"],
          ["r-3", "2026-03-01"],
          ["r-4", "2026-04-01"],
          ["r-5", "2026-05-01"],
        ]);
        yield* writerEngine.push.pipe(Effect.orDie);

        // The reader observes the newest two through the edge window.
        const readerEngine = yield* makeEngine(server.handler, "group-reader");
        const reader = Client.fromView(nodes, ClientView.fromEngine(readerEngine));
        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            reader.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            (rows) =>
              Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        const reviews = yield* eventually(Ref.get(latest), (rows) => rows.length === 2);
        expect(reviews.map((row) => row.id)).toEqual(["r-5", "r-4"]);

        // The point of ADR-0024: only the windowed rows reached the replica.
        const local = yield* readerEngine
          .query(Subset.make({ collection: "reviews" }))
          .pipe(Effect.orDie);
        expect(local.map((row) => row.id).sort()).toEqual(["r-4", "r-5"]);
      })
    )
  );

  it.effect("a newer child shifts the window on the poke-driven pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;
        const writerEngine = yield* makeEngine(server.handler, "group-shift-w");
        const writer = Client.fromView(nodes, ClientView.fromEngine(writerEngine));
        yield* writer.mutate("product/set", { id: "p-1", name: "Desk", featured: true });
        yield* seedReviews(writer, "p-1", [
          ["r-1", "2026-01-01"],
          ["r-2", "2026-02-01"],
        ]);
        yield* writerEngine.push.pipe(Effect.orDie);

        const readerEngine = yield* makeEngine(server.handler, "group-shift-r");
        const reader = Client.fromView(nodes, ClientView.fromEngine(readerEngine));
        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            reader.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            (rows) =>
              Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        yield* eventually(
          Ref.get(latest),
          (rows) => rows.map((row) => row.id).join() === "r-2,r-1"
        );

        // A newer review lands: the window shifts, the displaced row leaves
        // the replica (it is in no registered window).
        yield* writer.mutate("review/set", {
          id: "r-3",
          body: "newest",
          createdAt: "2026-03-01",
          productId: "p-1",
        });
        yield* writerEngine.push.pipe(Effect.orDie);
        yield* readerEngine.pull.pipe(Effect.orDie);
        yield* eventually(
          Ref.get(latest),
          (rows) => rows.map((row) => row.id).join() === "r-3,r-2"
        );
        const local = yield* readerEngine
          .query(Subset.make({ collection: "reviews" }))
          .pipe(Effect.orDie);
        expect(local.map((row) => row.id).sort()).toEqual(["r-2", "r-3"]);
      })
    )
  );

  it.effect("a parent leaving the root window releases its edge window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;
        const engine = yield* makeEngine(server.handler, "group-leave");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.mutate("product/set", { id: "p-1", name: "Desk", featured: true });
        yield* client.mutate("product/set", { id: "p-2", name: "Lamp", featured: true });
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({
              collection: "products",
              where: { featured: true },
              include: { reviews: { first: 2 } },
            }),
            () => Effect.void
          ).pipe(Effect.ignore)
        );
        yield* eventually(engine.activeSubscriptions, (all) => reviewWindows(all).length === 2);

        // p-2 leaves the root window; its per-parent window is released.
        yield* client.mutate("product/set", { id: "p-2", name: "Lamp", featured: false });
        yield* eventually(engine.activeSubscriptions, (all) => reviewWindows(all).length === 1);
      })
    )
  );

  it.effect("an unwindowed many-style include keeps the IN subset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;
        const engine = yield* makeEngine(server.handler, "group-in");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.mutate("product/set", { id: "p-1", name: "Desk", featured: true });
        yield* Effect.forkScoped(
          Stream.runForEach(
            // No `first`: the edge syncs unwindowed (the whole dependent set).
            client.observe({ collection: "products", include: { reviews: true } }),
            () => Effect.void
          ).pipe(Effect.ignore)
        );
        yield* eventually(
          engine.activeSubscriptions,
          (all) =>
            all.some((subset) => subset.collection === "reviews" && subset.limit === undefined) &&
            reviewWindows(all).length === 0
        );
      })
    )
  );
});

describe("over a hosted engine", () => {
  it.effect("windows cross the mirror protocol and register host-side", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer;
        const engine = yield* makeEngine(server.handler, "group-hosted");
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine, registry: nodes.collections });
        const client = yield* Client.connect({ nodes, mutations, channel: pair.mirror });

        yield* client.mutate("product/set", { id: "p-1", name: "Desk", featured: true });
        yield* seedReviews(client, "p-1", [
          ["r-1", "2026-01-01"],
          ["r-2", "2026-02-01"],
          ["r-3", "2026-03-01"],
        ]);

        const latest = yield* Ref.make<ReadonlyArray<{ id: string }>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(
            client.observe({ collection: "products", include: { reviews: { first: 2 } } }),
            (rows) =>
              Ref.set(latest, (rows[0]?.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>)
          ).pipe(Effect.ignore)
        );
        const reviews = yield* eventually(Ref.get(latest), (rows) => rows.length === 2);
        expect(reviews.map((row) => row.id)).toEqual(["r-3", "r-2"]);
        // The host registered the per-parent window on its engine.
        yield* eventually(engine.activeSubscriptions, (all) => reviewWindows(all).length === 1);
      })
    )
  );
});
