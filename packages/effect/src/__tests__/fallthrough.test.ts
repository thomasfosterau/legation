/**
 * Server-fallthrough reads (ADR-0025, program step 6): an uncovered
 * `Client.query` is answered by the server point-in-time — auth-filtered,
 * no CVR, nothing entering the replica — while covered reads stay local,
 * includes resolve through the same plan (ADR-0024 windows included), the
 * hosted tier forwards over the mirror protocol, and a transport without
 * `read` degrades to the local answer.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Authorization,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  Predicate,
  Server,
  Transport,
} from "../index.js";
import { ClientEngine, ClientView, EngineHost, MirrorChannel, Subset } from "../internal.js";
import { defined } from "./defined.js";

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

const makeServer = (policy?: Authorization.AuthPolicy) =>
  Effect.gen(function* () {
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
        policy:
          policy ??
          Authorization.policy({
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

const seed = (handler: Transport.ServerHandler) =>
  Effect.gen(function* () {
    const engine = yield* makeEngine(handler, "group-seed");
    const writer = Client.fromView(nodes, ClientView.fromEngine(engine));
    yield* writer.mutate("product/set", { id: "p-1", name: "Desk" });
    yield* writer.mutate("product/set", { id: "p-2", name: "Lamp" });
    for (const [id, at] of [
      ["r-1", "2026-01-01"],
      ["r-2", "2026-02-01"],
      ["r-3", "2026-03-01"],
    ] as const) {
      yield* writer.mutate("review/set", { id, body: id, createdAt: at, productId: "p-1" });
    }
    yield* engine.push.pipe(Effect.orDie);
  });

describe("the server tier", () => {
  it.effect("an uncovered query is answered by the server; the replica stays empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);

        const engine = yield* makeEngine(server.handler, "group-reader");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        // No subscriptions anywhere: the read falls through.
        const rows = yield* client.query({ collection: "products" });
        expect(
          Arr.sort(
            rows.map((row) => (row.value as { name: string }).name),
            Order.String
          )
        ).toEqual(["Desk", "Lamp"]);
        // Point-in-time: nothing was registered, nothing entered the replica.
        expect(yield* engine.activeSubscriptions).toHaveLength(0);
        const local = yield* engine
          .query(Subset.make({ collection: "products" }))
          .pipe(Effect.orDie);
        expect(local).toHaveLength(0);
      })
    )
  );

  it.effect("a covered query stays local — and can be staler than a fallthrough", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, server } = yield* makeServer();
        const engine = yield* makeEngine(server.handler, "group-covered");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        yield* client.mutate("product/set", { id: "p-1", name: "Desk" });
        yield* engine.push.pipe(Effect.orDie);
        // A windowed observation: under ADR-0029 an unwindowed one would
        // cover any sort of the collection, so the fallthrough below needs
        // a read the strict window rule rejects (a different sort).
        const observed = { collection: "products", order: ["-name"], first: 5 };
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(observed), (rows) => Ref.set(latest, rows)).pipe(
            Effect.ignore
          )
        );
        // The observer registered its window; a pull hydrates it.
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
        yield* engine.pull.pipe(Effect.orDie);
        yield* eventually(Ref.get(latest), (rows) => rows.length === 1);

        // An out-of-band write the server never announces (no broadcast).
        yield* backend
          .applyMutations({ clientGroupId: "oob" }, [
            {
              clientId: "cron",
              mutationId: 1,
              mutator: "product/set",
              args: { id: "p-2", name: "Lamp" },
              createdAt: 0,
            },
          ])
          .pipe(Effect.orDie);

        // Covered (the observed root window): answered from the replica.
        const covered = yield* client.query(observed);
        expect(covered).toHaveLength(1);
        // A shorter prefix of the same window is covered too (ADR-0029 rule 2).
        const prefix = yield* client.query({ ...observed, first: 2 });
        expect(prefix).toHaveLength(1);
        // A different sort is uncovered: the fallthrough sees the truth.
        const uncovered = yield* client.query({
          collection: "products",
          order: ["name"],
        });
        expect(uncovered).toHaveLength(2);
      })
    )
  );

  it.effect("fallthrough reads pass through the same auth filters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer(
          Authorization.policy({
            products: Authorization.allowAll,
            reviews: () => Effect.succeed(Predicate.eq("body", "r-2")),
          })
        );
        yield* seed(server.handler);

        const engine = yield* makeEngine(server.handler, "group-auth");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const rows = yield* client.query({ collection: "reviews" });
        expect(rows.map((row) => row.id)).toEqual(["r-2"]);
      })
    )
  );

  it.effect("includes resolve through the fallthrough, edge windows applied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);

        const engine = yield* makeEngine(server.handler, "group-include");
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        const rows = yield* client.query({
          collection: "products",
          include: { reviews: { first: 2 } },
          order: ["name"],
        });
        expect(rows).toHaveLength(2);
        const reviews = defined(rows[0]).related["reviews"] as ReadonlyArray<{ id: string }>;
        expect(reviews.map((row) => row.id)).toEqual(["r-3", "r-2"]);
        // Still nothing registered or replicated.
        expect(yield* engine.activeSubscriptions).toHaveLength(0);
      })
    )
  );

  it.effect("a transport without read degrades to the local answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);

        const store = yield* ClientStore.makeMemory;
        const full = yield* Transport.makeInMemory(server.handler, "group-noread");
        // A carrier that predates the read tier.
        const { read: _read, ...withoutRead } = full;
        const engine = yield* ClientEngine.make({
          clientId: "client-noread",
          clientGroupId: "group-noread",
          mutators: mutations,
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, withoutRead)
        );
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));

        const rows = yield* client.query({ collection: "products" });
        expect(rows).toHaveLength(0);
      })
    )
  );
});

describe("over a hosted engine", () => {
  it.effect("the mirror forwards the read to the host, which owns the transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);

        const engine = yield* makeEngine(server.handler, "group-hosted");
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine, registry: nodes.collections });
        const client = yield* Client.connect({ nodes, mutations, channel: pair.mirror });

        const rows = yield* client.query({
          collection: "products",
          include: { reviews: { first: 1 } },
          order: ["name"],
        });
        expect(rows).toHaveLength(2);
        expect(
          defined((defined(rows[0]).related["reviews"] as ReadonlyArray<{ id: string }>)[0]).id
        ).toBe("r-3");
        // The host registered nothing for it.
        expect(yield* engine.activeSubscriptions).toHaveLength(0);
      })
    )
  );
});
