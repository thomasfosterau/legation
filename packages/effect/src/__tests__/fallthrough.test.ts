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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
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
import { TestFailure } from "./test-failure.js";

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
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis);
    return Effect.sync(() => clearTimeout(timer));
  });

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(10);
    }
    return yield* Effect.die(new TestFailure({ message: "eventually: condition never held" }));
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
    yield* Effect.forEach(
      [
        ["r-1", "2026-01-01"],
        ["r-2", "2026-02-01"],
        ["r-3", "2026-03-01"],
      ] as const,
      ([id, at]) =>
        Effect.gen(function* () {
          yield* writer.mutate("review/set", { id, body: id, createdAt: at, productId: "p-1" });
        }),
      { concurrency: 1, discard: true }
    );
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

/** A reader engine over a transport the test can take offline. */
const makeReader = (handler: Transport.ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStore.makeMemory;
    const gate = yield* Transport.simulateOffline(yield* Transport.makeInMemory(handler, group));
    const engine = yield* ClientEngine.make({
      clientId: `client-${group}`,
      clientGroupId: group,
      mutators: mutations,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, gate.transport)
    );
    const client = Client.fromView(nodes, ClientView.fromEngine(engine));
    return { engine, client, setOffline: gate.setOffline };
  });

/** Whether rows were answered with the given completeness (#653). */
const answeredAs =
  (completeness: Client.Completeness) =>
  (rows: ReadonlyArray<Client.ResolvedRow>): boolean =>
    Option.contains(Client.completenessOf(rows), completeness);
const partial = answeredAs("partial");
const complete = answeredAs("complete");

describe("answer completeness (#653)", () => {
  const products = { collection: "products" };
  const withReviews = { collection: "products", include: { reviews: { first: 2 } } };

  /** Pull until a read is covered: a read with `include` pulls its edge windows second. */
  const pullUntilCovered = (
    engine: ClientEngine.ClientEngine,
    client: Client.Client,
    read: typeof withReviews
  ) =>
    eventually(engine.pull.pipe(Effect.orDie, Effect.andThen(client.coverageOf(read))), (verdict) =>
      P.isTagged(verdict, "Covered")
    );

  it.effect("offline, an uncovered query is partial; back online it is complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);
        const { client, setOffline } = yield* makeReader(server.handler, "group-offline");
        yield* client.mutate("product/set", { id: "p-9", name: "Local only" });

        yield* setOffline(true);
        const offline = yield* client.query(products);
        expect(offline.map((row) => row.id)).toEqual(["p-9"]);
        expect(Client.completenessOf(offline)).toEqual(Option.some("partial"));
        const offlineJoin = yield* client.query(withReviews);
        expect(Client.completenessOf(offlineJoin)).toEqual(Option.some("partial"));

        yield* setOffline(false);
        const online = yield* client.query(products);
        expect(online.map((row) => row.id).toSorted()).toEqual(["p-1", "p-2"]);
        expect(Client.completenessOf(online)).toEqual(Option.some("complete"));
        const onlineJoin = yield* client.query(withReviews);
        expect(Client.completenessOf(onlineJoin)).toEqual(Option.some("complete"));
      })
    )
  );

  it.effect("a covered query is complete, offline or not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);
        const { engine, client, setOffline } = yield* makeReader(server.handler, "group-covered");
        yield* client.subscribe(withReviews);
        yield* pullUntilCovered(engine, client, withReviews);

        const rows = yield* client.query(products);
        expect(rows).toHaveLength(2);
        expect(Client.completenessOf(rows)).toEqual(Option.some("complete"));

        yield* setOffline(true);
        expect(Client.completenessOf(yield* client.query(products))).toEqual(
          Option.some("complete")
        );
        expect(Client.completenessOf(yield* client.query(withReviews))).toEqual(
          Option.some("complete")
        );
      })
    )
  );

  it.effect("a transport without read answers an uncovered query partial", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        const store = yield* ClientStore.makeMemory;
        const { read: _read, ...withoutRead } = yield* Transport.makeInMemory(
          server.handler,
          "group-noread-mark"
        );
        const engine = yield* ClientEngine.make({
          clientId: "client-noread-mark",
          clientGroupId: "group-noread-mark",
          mutators: mutations,
        }).pipe(
          Effect.provideService(ClientStore.ClientStore, store),
          Effect.provideService(Transport.ClientTransport, withoutRead)
        );
        const client = Client.fromView(nodes, ClientView.fromEngine(engine));
        expect(Client.completenessOf(yield* client.query(products))).toEqual(
          Option.some("partial")
        );
      })
    )
  );

  it.effect("observe emits partial until its windows are pulled, then complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);
        const { engine, client, setOffline } = yield* makeReader(server.handler, "group-observe");
        yield* setOffline(true);

        const plain = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        const joined = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(products), (rows) => Ref.set(plain, rows))
        );
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe(withReviews), (rows) => Ref.set(joined, rows))
        );
        // Registered offline: nothing is pulled, so the empty replica answers partially.
        expect(yield* eventually(Ref.get(plain), partial)).toEqual([]);
        expect(yield* eventually(Ref.get(joined), partial)).toEqual([]);

        yield* setOffline(false);
        yield* engine.pull.pipe(Effect.orDie);
        expect(
          (yield* eventually(Ref.get(plain), complete)).map((row) => row.id).toSorted()
        ).toEqual(["p-1", "p-2"]);
        // The edge windows are registered from the root rows, so a second pull brings them.
        expect(
          yield* eventually(
            engine.pull.pipe(Effect.orDie, Effect.andThen(Ref.get(joined))),
            complete
          )
        ).toHaveLength(2);
      })
    )
  );

  it("rows no Client answered with carry no marker", () => {
    expect(Client.completenessOf([])).toEqual(Option.none());
  });
});

/**
 * A view whose `observe` holds every emission after the first `pass` until
 * `open`, while `pulledChanges` ticks through at once: the ordering a loaded
 * machine can produce, where a pull's tick reaches the Client before the
 * pull's rows do.
 */
const holdingRows = (view: ClientView.ClientView, pass: number) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const seen = yield* Ref.make(0);
    const held: ClientView.ClientView = {
      ...view,
      observe: (subset) =>
        view
          .observe(subset)
          .pipe(
            Stream.mapEffect((rows) =>
              Ref.getAndUpdate(seen, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n < pass ? Effect.succeed(rows) : Deferred.await(gate).pipe(Effect.as(rows))
                )
              )
            )
          ),
    };
    return { view: held, open: Deferred.succeed(gate, undefined) };
  });

/** Every emission of `stream`, in order, recorded as it arrives. */
const recording = (stream: Stream.Stream<ReadonlyArray<Client.ResolvedRow>>) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<ReadonlyArray<Client.ResolvedRow>>>([]);
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (rows) => Ref.update(log, (all) => [...all, rows]))
    );
    return log;
  });

/** A seeded server and a reader over a view that holds `observe`'s rows past `pass`. */
const setup = (group: string, pass: number) =>
  Effect.gen(function* () {
    const { server } = yield* makeServer();
    yield* seed(server.handler);
    const engine = yield* makeEngine(server.handler, group);
    const { view, open } = yield* holdingRows(ClientView.fromEngine(engine), pass);
    return { engine, client: Client.fromView(nodes, view), open };
  });

describe("completeness is judged against the rows it marks (#653)", () => {
  const products = { collection: "products" };

  it.effect("a pull's tick before its rows never marks the stale answer complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, client, open } = yield* setup("group-tick-first", 1);
        const log = yield* recording(client.observe(products));
        // The first answer, before any pull: the empty replica, partial.
        yield* eventually(Ref.get(log), (all) => all.length === 1);
        expect(yield* Ref.get(log)).toEqual([[]]);
        expect(Arr.every(yield* Ref.get(log), partial)).toBe(true);

        // The pull applies and ticks; its rows are held back.
        yield* engine.pull.pipe(Effect.orDie);
        const first = yield* eventually(
          Ref.get(log).pipe(Effect.map((all) => Arr.findFirst(all, complete))),
          Option.isSome
        );
        expect(Option.map(first, (rows) => rows.length)).toEqual(Option.some(2));

        yield* open;
        yield* eventually(Ref.get(log), (all) => all.length >= 3);
        expect(Arr.filter(yield* Ref.get(log), complete).map((rows) => rows.length)).not.toContain(
          0
        );
      })
    )
  );

  it.effect("rows emitted before a pull and judged after it are not marked complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, client, open } = yield* setup("group-rows-late", 0);
        const log = yield* recording(client.observe(products));
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
        // The pull lands while the pre-pull answer is still in flight.
        yield* engine.pull.pipe(Effect.orDie);
        yield* open;

        const first = yield* eventually(
          Ref.get(log).pipe(Effect.map((all) => Arr.findFirst(all, complete))),
          Option.isSome
        );
        expect(Option.map(first, (rows) => rows.length)).toEqual(Option.some(2));
        expect(Arr.filter(yield* Ref.get(log), complete).map((rows) => rows.length)).not.toContain(
          0
        );
      })
    )
  );
});

describe("answer completeness over a hosted engine (#653)", () => {
  it.effect("a mirror's answers carry the same marker as the host's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeServer();
        yield* seed(server.handler);

        const engine = yield* makeEngine(server.handler, "group-hosted-mark");
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine, registry: nodes.collections });
        const client = yield* Client.connect({ nodes, mutations, channel: pair.mirror });

        // Uncovered, the host forwards the read to the server.
        const forwarded = yield* client.query({ collection: "products" });
        expect(forwarded).toHaveLength(2);
        expect(Client.completenessOf(forwarded)).toEqual(Option.some("complete"));

        // Observing registers through the host; its pull completes the answer.
        const latest = yield* Ref.make<ReadonlyArray<Client.ResolvedRow>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(client.observe({ collection: "products" }), (rows) =>
            Ref.set(latest, rows)
          )
        );
        yield* eventually(engine.activeSubscriptions, (subs) => subs.length === 1);
        const answer = yield* eventually(
          engine.pull.pipe(Effect.orDie, Effect.andThen(Ref.get(latest))),
          (rows) => Option.contains(Client.completenessOf(rows), "complete")
        );
        expect(answer).toHaveLength(2);
      })
    )
  );
});
