/**
 * A registration is pulled only once a pull that started after it has applied (ADR-0029 section 3,
 * #426). A registration made while a pull is in flight is not marked by that pull, because the
 * pull may have read the subscriptions before it was made; the next pull marks it. The view
 * (`ClientView.pulled`) and the Client's coverage answer alike: a covered read is served locally
 * only when the windows its rows link to are pulled.
 *
 * The fake transport answers each pull from a script, and the in-flight test holds a pull until the
 * test releases it, so the interleaving is staged with Deferreds and no wall-clock time.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Client from "../Client.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientView from "../ClientView.js";
import * as Coverage from "../Coverage.js";
import * as Edge from "../Edge.js";
import * as EngineHost from "../EngineHost.js";
import { StoreError, TransportError } from "../Errors.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as Mutator from "../Mutator.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Node from "../Node.js";
import * as PullMarks from "../PullMarks.js";
import * as Predicate from "../Predicate.js";
import type { PatchOp, PullRequest, PullResponse } from "../Protocol.js";
import * as Query from "../Query.js";
import * as Subset from "../Subset.js";
import { ClientTransport } from "../Transport.js";

const Product = Node.make("products", {
  attributes: { name: Schema.String, sellerId: Schema.String },
  edges: {
    seller: Edge.one("sellers", { via: "sellerId" }),
    reviews: Edge.many("reviews", { inverse: "product" }),
  },
});
const Review = Node.make("reviews", {
  attributes: { productId: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const Seller = Node.make("sellers", { attributes: { name: Schema.String } });
const nodes = Node.registry([Product, Review, Seller]);
const products = { collection: "products" };

const empty: PullResponse = { cookie: "cvr-1", patch: [], lastMutationIds: {} };

/** A transport whose first pull waits for the test to release it; later pulls answer at once. */
const makeGated = Effect.gen(function* () {
  const issued = yield* Deferred.make<PullRequest>();
  const release = yield* Deferred.make<PullResponse, TransportError>();
  let calls = 0;
  const transport: ClientTransport = {
    push: () => Effect.die(new Error("push is not part of this test")),
    pull: (request) => {
      calls += 1;
      if (calls === 1) {
        return Deferred.succeed(issued, request).pipe(Effect.andThen(Deferred.await(release)));
      }
      return Effect.succeed(empty);
    },
    pokes: Stream.empty,
    status: Effect.succeed("disconnected"),
    statusChanges: Stream.empty,
  };
  return { transport, issued, release };
});

/** A transport whose n-th pull answers with the n-th patch of `patches`, and with nothing after them. */
const scripted = (patches: ReadonlyArray<ReadonlyArray<PatchOp>>): ClientTransport => {
  let calls = 0;
  return {
    push: () => Effect.die(new Error("push is not part of this test")),
    pull: () => {
      const index = calls;
      calls += 1;
      return Effect.succeed({
        cookie: `cvr-${index + 1}`,
        patch: patches[index] ?? [],
        lastMutationIds: {},
      });
    },
    pokes: Stream.empty,
    status: Effect.succeed("disconnected"),
    statusChanges: Stream.empty,
  };
};

const engineOver = (transport: ClientTransport) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    return yield* ClientEngineModule.make({
      clientId: "client-426",
      clientGroupId: "group-426",
      mutators: Mutator.registry([]),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const makeEngine = Effect.gen(function* () {
  const gated = yield* makeGated;
  const engine = yield* engineOver(gated.transport);
  return { engine, gated };
});

/** Whether the root window of a registration (`root`) is held and pulled in a summary. */
const rootPulled = (pulled: Coverage.Pulled, root: Subset.Subset): boolean =>
  pulled.windows.some(
    (window) => window.pulled && Coverage.windowKey(window.subset) === Coverage.windowKey(root)
  );

describe("pulled registrations (#426)", () => {
  it.effect("a registration made during an in-flight pull is not marked by that pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, gated } = yield* makeEngine;
        const view = ClientView.fromEngine(engine);
        const client = Client.fromView(nodes, view);
        const root = Subset.make(products);

        // A pull is in flight when the registration is made.
        const inFlight = yield* Effect.forkChild(engine.pull);
        yield* Deferred.await(gated.issued);
        yield* client.subscribe(products);
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");

        // The in-flight pull applies: it may predate the registration, so the registration stays unpulled.
        yield* Deferred.succeed(gated.release, empty);
        yield* Fiber.await(inFlight);
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");

        // The next pull started after the registration: it marks it.
        yield* engine.pull;
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(true);
        expect((yield* client.coverageOf(products))._tag).toBe("Covered");
      })
    )
  );

  it.effect("releasing the registration clears its mark; a fresh one starts unpulled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, gated } = yield* makeEngine;
        yield* Deferred.succeed(gated.release, empty);
        const view = ClientView.fromEngine(engine);
        const client = Client.fromView(nodes, view);
        const root = Subset.make(products);
        yield* client.subscribe(products);
        yield* engine.pull;
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(true);
        yield* client.unsubscribe(products);
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(false);
        yield* client.subscribe(products);
        expect(rootPulled(yield* view.pulled(Subset.hash(root)), root)).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");
      })
    )
  );

  it.effect("a subscribe the engine refuses leaves no open mark behind (S4)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine } = yield* makeEngine;
        const refusing: typeof engine = {
          ...engine,
          // A ClientEngine is typed infallible, but a transport-backed one can refuse at run time.
          subscribe: () => Effect.fail(new StoreError({ message: "refused" })) as never,
        };
        const view = ClientView.fromEngine(refusing);
        const root = Subset.make(products);
        expect(Exit.isFailure(yield* Effect.exit(view.subscribe(root)))).toBe(true);
        // The registration was opened before the refused subscribe; closing it on failure leaves
        // no registration, so its summary is the unheld one (the same value a never-made one reports).
        expect(yield* view.pulled(Subset.hash(root))).toBe(Coverage.NOT_PULLED);
      })
    )
  );

  it.effect(
    "the host subscribes to engine events before run returns, so a pull applied at once is not missed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine, gated } = yield* makeEngine;
          yield* Deferred.succeed(gated.release, empty);
          // Count when the host's event listener subscribes: `engineEvents` subscribes when it runs.
          let listeners = 0;
          const observed: typeof engine = {
            ...engine,
            engineEvents: Stream.suspend(() => {
              listeners += 1;
              return engine.engineEvents;
            }),
          };
          const { host } = yield* MirrorChannel.makeLoopbackPair;
          yield* EngineHost.run({ channel: host, engine: observed });
          // A pull applied as soon as the host is up must reach the listener: a forked
          // listener that had not yet subscribed would miss its `PullCompleted` (#426).
          expect(listeners).toBe(1);
        })
      )
  );
});

/** A read of products with the given edges included. */
const read = (include: Record<string, true>): Query.Read => ({ collection: "products", include });
/** A reviews window: the reviews of one product. */
const reviewWindow = (id: string) =>
  Subset.make({ collection: "reviews", where: Predicate.eq("productId", id) });
/** A put of one row, as a pull patch carries it. */
const put = (collection: string, id: string, value: Record<string, string>): PatchOp => ({
  _tag: "Put",
  collection,
  id,
  version: 1,
  value: { id, ...value },
});

/**
 * Subscribe the edge windows a registration's rows link to, as the engine host's reconcile does: the
 * windows of the registration's root rows, held under `key`.
 */
const reconcile = (
  engine: ClientEngineModule.ClientEngine,
  marks: PullMarks.PullMarks,
  key: string,
  plan: Query.Plan
) =>
  Effect.gen(function* () {
    const requested = yield* Coverage.requestedOf(nodes.collections, plan, engine.query);
    for (const window of requested.windows) yield* marks.wrap(key).subscribe(window);
  });

/** The coverage verdict of `requested` over the registration `key` held in `marks`. */
const verdictFor = (
  engine: ClientEngineModule.ClientEngine,
  marks: PullMarks.PullMarks,
  key: string,
  registration: Coverage.Registration,
  requested: Query.Read
) =>
  Coverage.coverageOf(
    nodes,
    engine.query,
    marks.registrations.pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.key === key)
          .map((entry) => ({
            root: registration.root,
            edges: registration.edges,
            pulled: entry.pulled,
          }))
      )
    )
  )(requested);

/** The fixture rows: two products of one seller, one review of the first. */
const seed = [
  put("products", "p-1", { name: "one", sellerId: "s-1" }),
  put("products", "p-2", { name: "two", sellerId: "s-1" }),
  put("reviews", "r-1", { productId: "p-1" }),
  put("sellers", "s-1", { name: "seller one" }),
];

describe("pulled windows of a relational registration (#426)", () => {
  it.effect(
    "a pulled root does not cover a relational read whose edge windows are not held (B1)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* engineOver(scripted([seed, [], []]));
          const marks = PullMarks.make(engine);
          const plan = Query.plan(nodes, read({ reviews: true }));
          const key = MirrorProtocol.relatedKey("products", plan.root, Query.edgeSelects(plan));
          const registration = Coverage.ofPlan(plan);
          const coverage = verdictFor(engine, marks, key, registration, read({ reviews: true }));

          // The root is subscribed and pulled; the reviews window its rows link to is not held.
          yield* marks.open(key, plan.root);
          yield* marks.wrap(key).subscribe(plan.root);
          yield* engine.pull;
          expect((yield* coverage)._tag).toBe("Uncovered");

          // Held but not yet pulled: still uncovered.
          yield* reconcile(engine, marks, key, plan);
          expect((yield* coverage)._tag).toBe("Uncovered");

          // A pull started after the windows were held: covered.
          yield* engine.pull;
          expect((yield* coverage)._tag).toBe("Covered");
        })
      )
  );

  it.effect(
    "a new edge window does not reset the windows already pulled: a read needing only them stays covered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* engineOver(
            scripted([seed, [put("products", "p-3", { name: "three", sellerId: "s-1" })], []])
          );
          const marks = PullMarks.make(engine);
          const plan = Query.plan(nodes, read({ reviews: true }));
          const key = MirrorProtocol.relatedKey("products", plan.root, Query.edgeSelects(plan));
          const registration = Coverage.ofPlan(plan);
          const firstOnly = verdictFor(engine, marks, key, registration, {
            collection: "products",
            where: Predicate.eq("id", "p-1"),
            include: { reviews: true },
          });
          const everything = verdictFor(engine, marks, key, registration, read({ reviews: true }));

          yield* marks.open(key, plan.root);
          yield* marks.wrap(key).subscribe(plan.root);
          yield* engine.pull;
          yield* reconcile(engine, marks, key, plan);
          yield* engine.pull;
          expect((yield* firstOnly)._tag).toBe("Covered");

          // The next pull brings a product the registration did not hold a window for. The read of
          // everything now links to it and is uncovered; the read of the first product still is covered.
          yield* engine.pull;
          expect((yield* everything)._tag).toBe("Uncovered");
          expect((yield* firstOnly)._tag).toBe("Covered");

          // Once the new window is held and a pull lands, the read of everything is covered too. Holding
          // it does not reset the first product's windows, which the read of the first product needs.
          yield* reconcile(engine, marks, key, plan);
          expect((yield* everything)._tag).toBe("Uncovered");
          expect((yield* firstOnly)._tag).toBe("Covered");
          yield* engine.pull;
          expect((yield* everything)._tag).toBe("Covered");
          expect((yield* firstOnly)._tag).toBe("Covered");
        })
      )
  );

  it.effect(
    "an unpulled window of a sibling parent does not uncover a read that needs only another parent's window (S1)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* engineOver(scripted([seed, []]));
          const marks = PullMarks.make(engine);
          const plan = Query.plan(nodes, read({ reviews: true }));
          const key = MirrorProtocol.relatedKey("products", plan.root, Query.edgeSelects(plan));
          const registration = Coverage.ofPlan(plan);
          const firstOnly = read({ reviews: true });
          const narrowed: Query.Read = {
            collection: "products",
            where: Predicate.eq("id", "p-1"),
            include: { reviews: true },
          };

          // The root and the p-1 reviews window are held and pulled.
          yield* marks.open(key, plan.root);
          yield* marks.wrap(key).subscribe(plan.root);
          yield* marks.wrap(key).subscribe(reviewWindow("p-1"));
          yield* engine.pull;

          // The p-2 reviews window is held and not yet pulled.
          yield* marks.wrap(key).subscribe(reviewWindow("p-2"));
          expect((yield* verdictFor(engine, marks, key, registration, narrowed))._tag).toBe(
            "Covered"
          );
          expect((yield* verdictFor(engine, marks, key, registration, firstOnly))._tag).toBe(
            "Uncovered"
          );

          // The next pull lands p-2's window, and the read of both products is covered.
          yield* engine.pull;
          expect((yield* verdictFor(engine, marks, key, registration, firstOnly))._tag).toBe(
            "Covered"
          );
        })
      )
  );
});
