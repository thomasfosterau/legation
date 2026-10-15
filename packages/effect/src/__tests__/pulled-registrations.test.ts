/**
 * A registration is pulled only once a pull that started after it has applied (ADR-0029 section 3,
 * #426). A registration made while a pull is in flight is not marked by that pull, because the
 * pull may have read the subscriptions before it was made; the next pull marks it. The view
 * (`ClientView.pulled`) and the Client's coverage answer alike: a covered read is served locally
 * only for a pulled registration.
 *
 * The fake transport holds each pull's answer until the test releases it, so the interleaving is
 * staged with Deferreds and no wall-clock time.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import * as Client from "../Client.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientView from "../ClientView.js";
import * as Coverage from "../Coverage.js";
import * as Edge from "../Edge.js";
import * as EngineHost from "../EngineHost.js";
import { TransportError } from "../Errors.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as Mutator from "../Mutator.js";
import * as MirrorProtocol from "../MirrorProtocol.js";
import * as Node from "../Node.js";
import * as PullMarks from "../PullMarks.js";
import * as Predicate from "../Predicate.js";
import type { PullRequest, PullResponse } from "../Protocol.js";
import * as Query from "../Query.js";
import * as Subset from "../Subset.js";
import { ClientTransport, type ClientTransport as ClientTransportShape } from "../Transport.js";

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
  const transport: ClientTransportShape = {
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

const makeEngine = Effect.gen(function* () {
  const gated = yield* makeGated;
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* ClientEngineModule.make({
    clientId: "client-426",
    clientGroupId: "group-426",
    mutators: Mutator.registry([]),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, gated.transport)
  );
  return { engine, gated };
});

describe("pulled registrations (#426)", () => {
  it.effect("a registration made during an in-flight pull is not marked by that pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { engine, gated } = yield* makeEngine;
        const view = ClientView.fromEngine(engine);
        const client = Client.fromView(nodes, view);
        const key = Subset.hash(Subset.make(products));

        // A pull is in flight when the registration is made.
        const inFlight = yield* Effect.forkChild(engine.pull);
        yield* Deferred.await(gated.issued);
        yield* client.subscribe(products);
        expect((yield* view.pulled(key)).root).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");

        // The in-flight pull applies: it may predate the registration, so the registration stays unpulled.
        yield* Deferred.succeed(gated.release, empty);
        yield* Fiber.await(inFlight);
        expect((yield* view.pulled(key)).root).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");

        // The next pull started after the registration: it marks it.
        yield* engine.pull;
        expect((yield* view.pulled(key)).root).toBe(true);
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
        const key = Subset.hash(Subset.make(products));
        yield* client.subscribe(products);
        yield* engine.pull;
        expect((yield* view.pulled(key)).root).toBe(true);
        yield* client.unsubscribe(products);
        expect((yield* view.pulled(key)).root).toBe(false);
        yield* client.subscribe(products);
        expect((yield* view.pulled(key)).root).toBe(false);
        expect((yield* client.coverageOf(products))._tag).toBe("Uncovered");
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
/** A seller window: the sellers with the given ids. */
const sellerWindow = (id: string) =>
  Subset.make({ collection: "sellers", where: Predicate.isIn("id", [id]) });
/** A reviews window: the reviews of one product. */
const reviewWindow = (id: string) =>
  Subset.make({ collection: "reviews", where: Predicate.eq("productId", id) });

describe("pulled windows of a relational registration (#426)", () => {
  it.effect(
    "a new edge window does not reset the windows already pulled: a read needing only them stays covered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine, gated } = yield* makeEngine;
          yield* Deferred.succeed(gated.release, empty);
          const marks = PullMarks.make(engine);
          // The registration: products with their seller and reviews edges.
          const root = Query.plan(nodes, read({ reviews: true, seller: true })).root;
          const key = MirrorProtocol.relatedKey("products", root, [
            { name: "reviews" },
            { name: "seller" },
          ]);
          const coverage = (requested: Query.Read) =>
            Effect.map(marks.registrations, (registrations) =>
              Coverage.verdictOf(
                registrations
                  .filter((entry) => entry.key === key)
                  .map((entry) => ({
                    root,
                    edges: [{ name: "reviews" }, { name: "seller" }],
                    pulled: entry.pulled,
                  })),
                Coverage.requestedOf(Query.plan(nodes, requested))
              )
            );
          const onlyReviews = read({ reviews: true });
          const onlySeller = read({ seller: true });

          // The registration and its windows, all pulled.
          yield* marks.open(key, root);
          yield* marks.wrap(key).subscribe(root);
          yield* marks.wrap(key).subscribe(reviewWindow("p-1"));
          yield* marks.wrap(key).subscribe(sellerWindow("s-1"));
          expect((yield* coverage(onlySeller))._tag).toBe("Uncovered");
          yield* engine.pull;
          expect((yield* coverage(onlySeller))._tag).toBe("Covered");
          expect((yield* coverage(onlyReviews))._tag).toBe("Covered");

          // A new seller window joins the registration: the reviews window stays pulled.
          yield* marks.wrap(key).subscribe(sellerWindow("s-2"));
          expect((yield* coverage(onlyReviews))._tag).toBe("Covered");
          expect((yield* coverage(onlySeller))._tag).toBe("Uncovered");

          // The read that needs the new window is covered once a pull lands.
          yield* engine.pull;
          expect((yield* coverage(onlySeller))._tag).toBe("Covered");
          expect((yield* coverage(onlyReviews))._tag).toBe("Covered");
          yield* marks.wrap(key).unsubscribe(sellerWindow("s-2"));
          yield* marks.wrap(key).unsubscribe(sellerWindow("s-1"));
          yield* marks.wrap(key).unsubscribe(reviewWindow("p-1"));
          yield* marks.wrap(key).unsubscribe(root);
          yield* marks.close(key);
        })
      )
  );
});
