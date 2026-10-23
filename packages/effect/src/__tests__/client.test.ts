/**
 * The Client facade (ADR-0022, program step 4): one object, two tiers.
 * Observing subscribes through the per-window ledger (one voice per
 * window; explicit pins survive observers); includes resolve through the
 * view's relational read with the plan's edge windows applied; Client.make
 * starts the sync loop itself; Client.connect drives a worker-hosted
 * engine over a channel with identical component-facing behavior.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Predicate,
  Query,
  QueryError,
  Transport,
} from "../index.js";
import {
  ClientEngine,
  ClientView,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  Subset,
  SyncServer,
} from "../internal.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String, categoryId: Schema.String },
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
        yield* eventually(engine.activeSubscriptions, (subs) => Arr.isReadonlyArrayEmpty(subs));
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
        yield* eventually(store.pendingMutations.pipe(Effect.orDie), (pending) =>
          Arr.isReadonlyArrayEmpty(pending)
        );
      })
    )
  );
});

/** An engine whose transport counts the fallthrough reads it carries. */
const makeCountingEngine = Effect.gen(function* () {
  const handler = yield* makeHandler;
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-coverage");
  const reads = yield* Ref.make(0);
  const counting: Transport.ClientTransport = {
    ...transport,
    read: (request) =>
      Ref.update(reads, (count) => count + 1).pipe(Effect.flatMap(() => transport.read!(request))),
  };
  const engine = yield* ClientEngine.make({
    clientId: "client-coverage",
    clientGroupId: "group-coverage",
    mutators: mutations,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, counting)
  );
  return { engine, reads };
});

/** The commerce example's `productPage` read (`examples/commerce/src/lib/domain.ts`). */
const productPage = (categoryId?: string) => ({
  collection: "products",
  ...(categoryId === undefined ? {} : { where: { categoryId } }),
  order: ["id"],
  first: 12,
});

/** The commerce shell's products pin (`shellReads`): windowed, ordered by id. */
const shellProducts = { collection: "products", order: ["id"], first: 100 };

/** A pull that starts after the registrations above, so they are pulled (ADR-0029 section 3, #426). */
const pulled = (engine: ClientEngine.ClientEngine) => engine.pull.pipe(Effect.orDie);

const rootHashes = (engine: ClientEngine.ClientEngine) =>
  Effect.map(engine.activeSubscriptions, (subsets) => subsets.map(Subset.hash));

describe("Client.query coverage (ADR-0029: conjunct subsumption with strict windows)", () => {
  it.effect("the shell's windowed subscription does not cover productPage({ categoryId })", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, reads } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        yield* client.mutate("product/set", { id: "p-1", name: "Desk", categoryId: "c-audio" });
        yield* client.mutate("product/set", { id: "p-2", name: "Lamp", categoryId: "c-light" });
        yield* engine.push.pipe(Effect.orDie);

        yield* client.subscribe(shellProducts);
        // Registered but not yet pulled: the rows are not in the replica, so nothing covers (#426).
        expect((yield* client.coverageOf(productPage()))._tag).toBe("Uncovered");
        yield* pulled(engine);
        // Row 1 of the windowed table: a prefix of the same window — local.
        const whole = yield* client.coverageOf(productPage());
        expect(whole._tag).toBe("Covered");
        yield* client.query(productPage());
        expect(yield* Ref.get(reads)).toBe(0);

        // Row 2: a narrower predicate over the window — strict, falls through.
        expect((yield* client.coverageOf(productPage("c-audio")))._tag).toBe("Uncovered");
        const rows = yield* client.query(productPage("c-audio"));
        expect(rows.map((row) => row.id)).toEqual(["p-1"]);
        expect(yield* Ref.get(reads)).toBe(1);
        // Nothing but the pinned root window was ever registered.
        expect(yield* rootHashes(engine)).toEqual([
          Subset.hash(Query.plan(nodes, shellProducts).root),
        ]);
      })
    )
  );

  it.effect("an unwindowed products subscription covers productPage({ categoryId }) locally", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, reads } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const whole = { collection: "products" };
        yield* client.subscribe(whole);
        yield* pulled(engine);
        // Optimistic rows only: a fallthrough would return the server's (none).
        yield* client.mutate("product/set", { id: "p-1", name: "Desk", categoryId: "c-audio" });
        yield* client.mutate("product/set", { id: "p-2", name: "Lamp", categoryId: "c-light" });

        const root = Query.plan(nodes, whole).root;
        expect(yield* client.coverageOf(productPage("c-audio"))).toEqual({
          _tag: "Covered",
          by: { root, edges: [] },
          hash: Subset.hash(root),
        });
        const rows = yield* client.query(productPage("c-audio"));
        expect(rows.map((row) => row.id)).toEqual(["p-1"]);
        expect(yield* Ref.get(reads)).toBe(0);

        // Observing still registers exactly as before: the root window, once.
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(whole), () => Effect.void).pipe(Effect.ignore)
        );
        yield* sleepReal(50);
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);
        // The observer outlives the pin's release; it does not add a second voice.
        yield* client.unsubscribe(whole);
        expect((yield* client.coverageOf(productPage("c-audio")))._tag).toBe("Covered");
      })
    )
  );

  it.effect(
    "a cursor without a limit is a window: after p-50 never covers the whole collection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine } = yield* makeCountingEngine;
          const client = Client.fromView(nodes, ClientView.fromEngine(engine));
          yield* client.subscribe({ collection: "products", after: "p-50" });
          yield* pulled(engine);
          expect((yield* client.coverageOf({ collection: "products" }))._tag).toBe("Uncovered");
          expect(
            (yield* client.coverageOf({ collection: "products", after: "p-50", first: 5 }))._tag
          ).toBe("Covered");
          expect((yield* client.coverageOf({ collection: "products", after: "p-51" }))._tag).toBe(
            "Uncovered"
          );
        })
      )
  );

  it.effect("an explicit pin registers its edge windows, so a read with include is covered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        yield* client.mutate("product/set", { id: "p-2", name: "Lamp" });

        const pinned = { collection: "products", include: { reviews: { first: 2 } } };
        yield* client.subscribe(pinned);
        const root = Query.plan(nodes, pinned).root;
        // The root window AND one per-parent review window (ADR-0024) are
        // registered with the engine — the same registration `observe` runs.
        const perParent = (id: string) =>
          Subset.hash(
            Subset.make({
              collection: "reviews",
              where: Predicate.eq("productId", id),
              orderBy: [{ field: "createdAt", direction: "desc" }],
              limit: 2,
            })
          );
        const registered = yield* eventually(rootHashes(engine), (hashes) => hashes.length === 3);
        expect(new Set(registered)).toEqual(
          new Set([Subset.hash(root), perParent("p-1"), perParent("p-2")])
        );
        yield* pulled(engine);

        // The ledger records the edge selects, so rule 4 holds ...
        expect(yield* client.coverageOf({ collection: "products" })).toEqual({
          _tag: "Covered",
          by: { root, edges: [{ name: "reviews", first: 2 }] },
          hash: Subset.hash(root),
        });
        expect(
          (yield* client.coverageOf({
            collection: "products",
            include: { reviews: { first: 1 } },
          }))._tag
        ).toBe("Covered");
        // ... strictly: a windowed edge select never covers an unwindowed include.
        expect(
          (yield* client.coverageOf({ collection: "products", include: { reviews: true } }))._tag
        ).toBe("Uncovered");

        // The edge windows track the linkage while the pin stands ...
        yield* client.mutate("product/set", { id: "p-3", name: "Chair" });
        yield* eventually(rootHashes(engine), (hashes) => hashes.includes(perParent("p-3")));
        // ... and release with it, root included.
        yield* client.unsubscribe(pinned);
        yield* eventually(rootHashes(engine), (hashes) => Arr.isReadonlyArrayEmpty(hashes));
      })
    )
  );

  it.effect("a pin with include on an offline Client registers without a server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // No transport at all: the relational registration's initial pull
        // fails, which only delays rows — the pin must still hold.
        const client = yield* Client.make({ nodes, mutations });
        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        const pinned: Query.Read = { collection: "products", include: { reviews: true } };
        yield* client.subscribe(pinned);
        // Offline no pull ever lands, so the pin covers nothing: the read is
        // forwarded (here, answered locally), never Covered (#426).
        expect(
          (yield* client.coverageOf({ collection: "products", include: { reviews: true } }))._tag
        ).toBe("Uncovered");
        yield* client.unsubscribe(pinned);
        expect((yield* client.coverageOf({ collection: "products" }))._tag).toBe("Uncovered");
      })
    )
  );

  it.effect("releasing an edged pin never drops a root another registration still holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        const plain = { collection: "products" };
        const withInclude: Query.Read = { collection: "products", include: { reviews: true } };
        const root = Query.plan(nodes, plain).root;
        yield* client.subscribe(plain);
        yield* client.subscribe(withInclude);
        yield* eventually(rootHashes(engine), (hashes) => hashes.length === 2);
        yield* pulled(engine);

        // The relational registration subscribed the root too; releasing it
        // must leave the plain pin's root with the engine (counted voice).
        yield* client.unsubscribe(withInclude);
        yield* eventually(rootHashes(engine), (hashes) => hashes.length === 1);
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);
        expect((yield* client.coverageOf(plain))._tag).toBe("Covered");
        expect((yield* client.coverageOf(withInclude))._tag).toBe("Uncovered");

        // An observer with include beside the pin behaves the same way.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Stream.runForEach(client.observe(withInclude), () => Effect.void).pipe(Effect.ignore)
            );
            yield* eventually(rootHashes(engine), (hashes) => hashes.length === 2);
          })
        );
        yield* eventually(rootHashes(engine), (hashes) => hashes.length === 1);
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);

        yield* client.unsubscribe(plain);
        yield* eventually(rootHashes(engine), (hashes) => Arr.isReadonlyArrayEmpty(hashes));
      })
    )
  );

  it.effect("an unsubscribe racing an in-flight subscribe of the same read leaks nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        // A view whose edge registration waits on a gate: the subscribe is
        // mid-registration when the unsubscribe arrives.
        const gate = yield* Deferred.make<void>();
        const view = ClientView.fromEngine(engine);
        const slow: ClientView.ClientView = {
          ...view,
          pinEdges: (registry, collection, subset, edges) =>
            Deferred.await(gate).pipe(
              Effect.andThen(view.pinEdges(registry, collection, subset, edges))
            ),
        };
        const client = Client.fromView(nodes, slow);
        const pinned: Query.Read = { collection: "products", include: { reviews: true } };

        const subscribing = yield* Effect.forkScoped(client.subscribe(pinned));
        yield* sleepReal(20);
        const unsubscribing = yield* Effect.forkScoped(client.unsubscribe(pinned));
        yield* sleepReal(20);
        // The unsubscribe must wait for the registration rather than run
        // ahead of it: otherwise it releases nothing and the registration
        // then lands with nobody holding it.
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(subscribing);
        yield* Fiber.join(unsubscribing);

        expect((yield* client.coverageOf(pinned))._tag).toBe("Uncovered");
        expect(yield* client.subscriptions).toEqual([]);
        yield* eventually(rootHashes(engine), (hashes) => Arr.isReadonlyArrayEmpty(hashes));
      })
    )
  );

  it.effect("two pins sharing a root are released one at a time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const plain = { collection: "products" };
        const withInclude: Query.Read = { collection: "products", include: { reviews: true } };
        const root = Query.plan(nodes, plain).root;
        yield* client.subscribe(plain);
        yield* client.subscribe(withInclude);
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);
        yield* pulled(engine);

        // Releasing one pin keeps the other's coverage and its window in the view.
        yield* client.unsubscribe(plain);
        expect((yield* client.coverageOf(productPage("c-audio")))._tag).toBe("Covered");
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);

        // Releasing the last pin drops both.
        yield* client.unsubscribe(withInclude);
        expect((yield* client.coverageOf(productPage("c-audio")))._tag).toBe("Uncovered");
        yield* eventually(rootHashes(engine), (hashes) => Arr.isReadonlyArrayEmpty(hashes));
      })
    )
  );
});

/**
 * A stand-in for `@thomasfosterau/legation-jsonapi`'s `JsonApiQuery.urlReads` — this package
 * cannot depend on it (ADR-0006). Understands `/{collection}?filter[f]=v&
 * include=a,b`, canonicalises to sorted parameters, and refuses what the
 * real bridge refuses: an unknown collection, an unknown parameter, a read
 * with no URL form (a per-edge window).
 */
const stubUrls: Client.UrlReads = {
  parse: (url) =>
    Effect.suspend(() => {
      const { pathname, searchParams } = new URL(url, "http://localhost");
      const collection = pathname.split("/").findLast((s) => Str.isNonEmpty(s)) ?? "";
      if (!nodes.nodes.has(collection)) {
        return Effect.fail(
          new QueryError({ message: `Unknown collection: ${collection}`, query: collection })
        );
      }
      const where: Record<string, string> = {};
      const include: Record<string, true> = {};
      for (const [key, value] of searchParams) {
        const filter = /^filter\[(\w+)\]$/.exec(key);
        if (filter !== null) where[filter[1]!] = value;
        else if (key === "include") for (const edge of value.split(",")) include[edge] = true;
        else {
          return Effect.fail(
            new QueryError({ message: `Unsupported ${key}`, query: collection, parameter: key })
          );
        }
      }
      return Effect.succeed({
        collection,
        ...(R.isEmptyReadonlyRecord(where) ? {} : { where }),
        ...(R.isEmptyReadonlyRecord(include) ? {} : { include }),
      });
    }),
  canonical: (read) =>
    Effect.suspend(() => {
      const compiled = Query.plan(nodes, read);
      if (compiled.edges.some((edge) => edge.first !== undefined)) {
        return Effect.fail(new QueryError({ message: "no URL form", query: read.collection }));
      }
      const where = read.where !== undefined && !("_tag" in read.where) ? read.where : {};
      const params = [
        ...(Arr.isReadonlyArrayEmpty(compiled.edges)
          ? []
          : [
              `include=${compiled.edges
                .map((edge) => edge.edge)
                .toSorted()
                .join(",")}`,
            ]),
        ...Object.entries(where)
          .toSorted(([a], [b]) => (a < b ? -1 : 1))
          .map(([field, value]) => `filter[${field}]=${String(value)}`),
      ];
      return Effect.succeed(
        `/${read.collection}${Arr.isReadonlyArrayEmpty(params) ? "" : `?${params.join("&")}`}`
      );
    }),
};

describe("Client.subscribe(url) (ADR-0029 section 2: URL-keyed subscriptions)", () => {
  it.effect("subscribe(url) and subscribe(read) of one query share one ledger entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine), { urls: stubUrls });
        const read: Query.Read = {
          collection: "products",
          where: { categoryId: "c-audio" },
          include: { reviews: true },
        };
        yield* client.subscribe("/products?include=reviews&filter[categoryId]=c-audio");
        yield* client.subscribe(read);
        // A non-canonical spelling (parameter order, an API prefix) too.
        yield* client.subscribe("/api/products?filter[categoryId]=c-audio&include=reviews");
        expect(yield* client.subscriptions).toEqual([
          "/products?include=reviews&filter[categoryId]=c-audio",
        ]);
        const root = Query.plan(nodes, read).root;
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);
        yield* pulled(engine);
        expect(yield* client.coverageOf(read)).toEqual({
          _tag: "Covered",
          by: { root, edges: [{ name: "reviews" }] },
          hash: Subset.hash(root),
          url: "/products?include=reviews&filter[categoryId]=c-audio",
        });

        // Three pins, three releases — by URL or by read, in any order.
        yield* client.unsubscribe(read);
        yield* client.unsubscribe("/products?filter[categoryId]=c-audio&include=reviews");
        expect(yield* client.subscriptions).toHaveLength(1);
        expect(yield* rootHashes(engine)).toEqual([Subset.hash(root)]);
        yield* client.unsubscribe("/products?include=reviews&filter[categoryId]=c-audio");
        expect(yield* client.subscriptions).toEqual([]);
        yield* eventually(rootHashes(engine), (hashes) => Arr.isReadonlyArrayEmpty(hashes));
      })
    )
  );

  it.effect("a URL the bridge refuses fails with a QueryError and registers nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine), { urls: stubUrls });
        const unknown = yield* Effect.flip(client.subscribe("/widgets"));
        expect(unknown._tag).toBe("QueryError");
        const parameter = yield* Effect.flip(client.subscribe("/products?sort=name"));
        expect(parameter._tag).toBe("QueryError");
        expect((parameter as QueryError).parameter).toBe("sort");
        const edge = yield* Effect.flip(client.subscribe("/products?include=nope"));
        expect(edge._tag).toBe("QueryError");
        expect(yield* client.subscriptions).toEqual([]);
        expect(yield* rootHashes(engine)).toEqual([]);
        expect((yield* client.coverageOf({ collection: "products" }))._tag).toBe("Uncovered");
      })
    )
  );

  it.effect("a Client built without URL reads fails a URL call with a QueryError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const error = yield* Effect.flip(client.subscribe("/products"));
        expect(error._tag).toBe("QueryError");
        expect(error.message).toContain("urls");
        expect(yield* rootHashes(engine)).toEqual([]);
        // Pins by read still work, and are listed only when they have a URL.
        yield* client.subscribe({ collection: "products" });
        expect(yield* client.subscriptions).toEqual([]);
      })
    )
  );

  it.effect("the URL leaves with the last pin, even while an observer keeps the entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine), { urls: stubUrls });
        const read: Query.Read = { collection: "products" };
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(read), () => Effect.void).pipe(Effect.ignore)
        );
        yield* eventually(rootHashes(engine), (hashes) => hashes.length === 1);

        yield* client.subscribe("/products");
        expect(yield* client.subscriptions).toEqual(["/products"]);
        yield* pulled(engine);
        const pinned = yield* client.coverageOf(read);
        expect(pinned._tag === "Covered" ? pinned.url : pinned).toBe("/products");

        // The observer keeps the entry (and the window); the pin's identity goes.
        yield* client.unsubscribe("/products");
        expect(yield* client.subscriptions).toEqual([]);
        const observed = yield* client.coverageOf(read);
        expect(observed._tag).toBe("Covered");
        expect(observed._tag === "Covered" ? observed.url : "listed").toBeUndefined();
        expect(yield* rootHashes(engine)).toHaveLength(1);

        // Pinning again names it again.
        yield* client.subscribe(read);
        expect(yield* client.subscriptions).toEqual(["/products"]);
      })
    )
  );

  it.effect("a pin whose read has no URL form is held but not listed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeCountingEngine;
        const client = Client.fromView(nodes, ClientView.fromEngine(engine), { urls: stubUrls });
        yield* client.subscribe({ collection: "products", include: { reviews: { first: 2 } } });
        yield* client.subscribe({ collection: "products" });
        expect(yield* client.subscriptions).toEqual(["/products"]);
        yield* pulled(engine);
        const verdict = yield* client.coverageOf({
          collection: "products",
          include: { reviews: { first: 1 } },
        });
        expect(verdict._tag).toBe("Covered");
        expect(verdict._tag === "Covered" ? verdict.url : "listed").toBeUndefined();
      })
    )
  );
});

describe("Client.make defaults (zero wiring)", () => {
  it.effect("no store, no transport: a purely local Client just works", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Nothing provided: memory store, offline transport, no sync loop.
        const client = yield* Client.make({ nodes, mutations });

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        const rows = yield* client.query({ collection: "products" });
        expect(rows).toHaveLength(1);
        expect((rows[0]!.value as { name: string }).name).toBe("Desk");

        // Live reads work too — entirely against the local replica.
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows)
          ).pipe(Effect.ignore)
        );
        yield* eventually(Ref.get(latest), (current) => current.length === 1);
      })
    )
  );

  it.effect("store and transport as options: the sync loop drains the journal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeHandler;
        const store = yield* ClientStore.makeMemory;
        const transport = yield* Transport.makeInMemory(handler, "group-options");
        // No context provides anywhere: everything arrives as options.
        const client = yield* Client.make({
          nodes,
          mutations,
          clientGroupId: "group-options",
          store,
          transport,
          syncLoop: { pushDebounce: "10 millis" },
        });

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        yield* eventually(store.pendingMutations.pipe(Effect.orDie), (pending) =>
          Arr.isReadonlyArrayEmpty(pending)
        );
      })
    )
  );

  it.effect("options win over context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* makeHandler;
        const optionStore = yield* ClientStore.makeMemory;
        const contextStore = yield* ClientStore.makeMemory;
        const transport = yield* Transport.makeInMemory(handler, "group-precedence");
        const client = yield* Client.make({
          nodes,
          mutations,
          clientGroupId: "group-precedence",
          store: optionStore,
          transport,
          syncLoop: { pushDebounce: "10 millis" },
        }).pipe(Effect.provideService(ClientStore.ClientStore, contextStore));

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        // The journal lives in the OPTION store, not the context one.
        yield* eventually(optionStore.pendingMutations.pipe(Effect.orDie), (pending) =>
          Arr.isReadonlyArrayEmpty(pending)
        );
        expect(yield* contextStore.pendingMutations.pipe(Effect.orDie)).toHaveLength(0);
        const confirmed = yield* client.query({ collection: "products" });
        expect(confirmed).toHaveLength(1);
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

// ─── #426: a read judges and answers from one snapshot of its root ───────────

/** Two engines over one server: `reader` is the replica under test; `writer` puts rows it has not pulled. */
const makeRacePair = Effect.gen(function* () {
  const handler = yield* makeHandler;
  const make = (clientId: string) =>
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      const transport = yield* Transport.makeInMemory(handler, `group-${clientId}`);
      return yield* ClientEngine.make({
        clientId,
        clientGroupId: `group-${clientId}`,
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );
    });
  return { reader: yield* make("client-reader"), writer: yield* make("client-writer") };
});

describe("Client.query judges and answers from one snapshot (#426)", () => {
  it.effect(
    "a pull between the judgment and the answer cannot serve a root row with unpulled reviews",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { reader, writer } = yield* makeRacePair;
          yield* writer.mutate("product/set", { id: "p-1", name: "Desk" });
          yield* writer.mutate("product/set", { id: "p-2", name: "Lamp" });
          yield* writer.mutate("review/set", {
            id: "r-1",
            productId: "p-1",
            body: "Solid",
            createdAt: "2026-01-01",
          });
          yield* writer.mutate("review/set", {
            id: "r-2",
            productId: "p-2",
            body: "Bright",
            createdAt: "2026-01-02",
          });
          yield* writer.push.pipe(Effect.orDie);

          // Armed: the second read of the root subset lands another client's write and its pull
          // before it returns. A covered answer reads the root once (the snapshot), so the race
          // never runs; a second read of the root would serve p-3 with no reviews pulled.
          const reviewed: Query.Read = { collection: "products", include: { reviews: true } };
          const rootHash = Subset.hash(Query.plan(nodes, reviewed).root);
          const armed = yield* Ref.make(false);
          const rootReads = yield* Ref.make(0);
          const race = Effect.gen(function* () {
            yield* writer.mutate("product/set", { id: "p-3", name: "Chair" });
            yield* writer.mutate("review/set", {
              id: "r-3",
              productId: "p-3",
              body: "Firm",
              createdAt: "2026-01-03",
            });
            yield* writer.push.pipe(Effect.orDie);
            yield* reader.pull.pipe(Effect.orDie);
          }).pipe(Effect.orDie);
          const base = ClientView.fromEngine(reader);
          const view: ClientView.ClientView = {
            ...base,
            query: (subset) =>
              Effect.gen(function* () {
                if (Subset.hash(subset) === rootHash && (yield* Ref.get(armed))) {
                  if ((yield* Ref.updateAndGet(rootReads, (count) => count + 1)) === 2) {
                    yield* race;
                  }
                }
                return yield* base.query(subset);
              }),
          };
          const client = Client.fromView(nodes, view);

          // Pin the reviewed products and pull until their root and review windows are pulled.
          yield* client.subscribe(reviewed);
          for (let attempt = 0; attempt < 20; attempt++) {
            yield* reader.pull.pipe(Effect.orDie);
            yield* Effect.yieldNow;
            if ((yield* client.coverageOf(reviewed))._tag === "Covered") break;
          }
          expect((yield* client.coverageOf(reviewed))._tag).toBe("Covered");

          yield* Ref.set(armed, true);
          const rows = yield* client.query(reviewed);
          // One read of the root for the whole answer: the verdict and the answer share it.
          expect(yield* Ref.get(rootReads)).toBe(1);
          // The answer is the snapshot the verdict judged: p-1 and p-2, each with its reviews.
          expect(
            rows.map((row) => [
              row.id,
              ((row.related["reviews"] ?? []) as ReadonlyArray<{ id: string }>).map(
                (review) => review.id
              ),
            ])
          ).toEqual([
            ["p-1", ["r-1"]],
            ["p-2", ["r-2"]],
          ]);
        })
      )
  );
});

it.effect("a snapshot of another subset is not judged over (#426)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { reader, writer } = yield* makeRacePair;
      yield* writer.mutate("product/set", { id: "p-1", name: "Desk" });
      yield* writer.mutate("review/set", {
        id: "r-1",
        productId: "p-1",
        body: "Solid",
        createdAt: "2026-01-01",
      });
      yield* writer.push.pipe(Effect.orDie);
      const client = Client.fromView(nodes, ClientView.fromEngine(reader));
      const reviewed: Query.Read = { collection: "products", include: { reviews: true } };
      yield* client.subscribe(reviewed);
      for (let attempt = 0; attempt < 20; attempt++) {
        yield* reader.pull.pipe(Effect.orDie);
        yield* Effect.yieldNow;
        if ((yield* client.coverageOf(reviewed))._tag === "Covered") break;
      }
      expect((yield* client.coverageOf(reviewed))._tag).toBe("Covered");
      // p-2 reaches the replica's products without its reviews window: the read now links to a
      // window that is not pulled.
      yield* writer.mutate("product/set", { id: "p-2", name: "Lamp" });
      yield* writer.push.pipe(Effect.orDie);
      yield* reader.pull.pipe(Effect.orDie);
      expect((yield* client.query({ collection: "products" })).map((row) => row.id)).toContain(
        "p-2"
      );
      expect((yield* client.coverageOf(reviewed))._tag).toBe("Uncovered");
      // A snapshot of the reviews, with no rows, names another subset: it must not stand in for
      // the products' rows, or the window p-2 links to would go unjudged and the read covered.
      const reviews = Query.plan(nodes, { collection: "reviews" }).root;
      expect(
        (yield* client.coverageOf(reviewed, { snapshot: { subset: reviews, rows: [] } }))._tag
      ).toBe("Uncovered");
    })
  )
);
