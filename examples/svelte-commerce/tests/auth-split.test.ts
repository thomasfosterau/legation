/**
 * The public/private auth split over the real stack (SyncServer + SqlBackend
 * over node:sqlite + IdentityResolver from the client-group binding):
 *
 * - anonymous clients sync the public catalog and get an EMPTY result — not
 *   an error — for private subsets (the deliberate `allowAll` opt-in against
 *   deny-by-default, plus the empty allow-set for anonymous identity);
 * - a bound client group syncs exactly its own private rows, and a
 *   subscription for another user's rows yields nothing (client predicates
 *   only narrow what the auth filter allows);
 * - a push claiming another user's id is permanently rejected (identity is
 *   resolved server-side, never from args) and the optimistic row drops on
 *   the next rebase;
 * - `order/place` round-trips: journal → push (server recomputes from the
 *   authoritative cart) → pull (order + items + stock decrement + cleared
 *   cart sync back).
 */
import { describe, expect, it } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { ClientEngine, ClientStore, Transport } from "@legation/effect";
import {
  allVariants,
  myCartItems,
  myOrderItems,
  myOrders,
  mutators,
  productPage,
  type CartItem,
  type Order,
  type Variant,
} from "../src/lib/domain.js";
import { openDatabase, seed } from "../server/db.js";
import { bindClientGroup, syncLayer } from "../server/runtime.js";

const makeWorld = Effect.fnUntraced(function* () {
  const db = openDatabase(":memory:");
  seed(db);
  const context = yield* Layer.build(syncLayer(db));
  return { db, handler: Context.get(context, Transport.ServerHandler) };
});

const makeClient = (handler: Transport.ServerHandler, clientId: string, clientGroupId: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStore.makeMemory;
    const transport = yield* Transport.makeInMemory(handler, clientGroupId);
    const engine = yield* ClientEngine.make({ clientId, clientGroupId, mutators }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    return engine;
  });

describe("public/private auth split", () => {
  it.effect("anonymous clients sync the catalog; private subsets stay empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeWorld();
        const anon = yield* makeClient(handler, "anon", "group-anon");
        yield* anon.subscribe(productPage({}));
        yield* anon.subscribe(myCartItems("u1"));
        yield* anon.pull;

        const products = yield* anon.query(productPage({}));
        expect(products.length).toBeGreaterThan(0);
        expect(yield* anon.query(myCartItems("u1"))).toEqual([]);
      })
    )
  );

  it.effect("a bound group syncs exactly its own rows; foreign subsets yield nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { db, handler } = yield* makeWorld();
        db.prepare(
          "INSERT INTO cartItems (id, userId, variantId, qty) VALUES ('ci-1', 'u1', 'v-01a', 1), ('ci-2', 'u2', 'v-02a', 2)"
        ).run();
        bindClientGroup(db, "group-u1", "u1");

        const client = yield* makeClient(handler, "c-u1", "group-u1");
        yield* client.subscribe(myCartItems("u1"));
        yield* client.subscribe(myCartItems("u2")); // someone else's
        yield* client.pull;

        const mine = yield* client.query(myCartItems("u1"));
        expect(mine.map((row) => row.id)).toEqual(["ci-1"]);
        // The auth filter AND-ed into the subscription leaves nothing for u2.
        expect(yield* client.query(myCartItems("u2"))).toEqual([]);
      })
    )
  );

  it.live("a push claiming another user's id is permanently rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { db, handler } = yield* makeWorld();
        bindClientGroup(db, "group-u1", "u1");
        const client = yield* makeClient(handler, "c-u1", "group-u1");
        yield* client.subscribe(myCartItems("u2"));

        const handle = yield* client.mutateWithAck("cart/add", {
          id: "ci-forged",
          userId: "u2", // forged — the resolver says this group is u1
          variantId: "v-01a",
          qty: 1,
        });
        yield* client.push;
        expect(yield* handle.acknowledged).toEqual({
          _tag: "rejected",
          reason: "identity mismatch",
        });

        // Nothing landed server-side.
        const rows = db.prepare("SELECT COUNT(*) AS n FROM cartItems").get() as { n: number };
        expect(rows.n).toBe(0);
      })
    )
  );

  it.live("order/place round-trips: server recomputes, stock decrements, cart clears", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { db, handler } = yield* makeWorld();
        bindClientGroup(db, "group-u1", "u1");
        const client = yield* makeClient(handler, "c-u1", "group-u1");
        yield* client.subscribe(myCartItems("u1"));
        yield* client.subscribe(myOrders("u1"));
        yield* client.subscribe(myOrderItems("u1"));
        yield* client.subscribe(allVariants);
        yield* client.pull;

        yield* client.mutate("cart/add", {
          id: "ci-1",
          userId: "u1",
          variantId: "v-01a",
          qty: 2,
        });
        yield* client.push;
        yield* client.pull;

        const cart = (yield* client.query(myCartItems("u1"))).map((row) => row.value as CartItem);
        expect(cart.map((item) => item.variantId)).toEqual(["v-01a"]);

        yield* client.mutate("order/place", {
          orderId: "o-1",
          userId: "u1",
          createdAt: "2026-07-03T00:00:00Z",
          items: cart.map((item) => ({
            cartItemId: item.id,
            variantId: item.variantId,
            qty: item.qty,
            priceCents: 14900,
          })),
        });
        yield* client.push;
        yield* client.pull;

        const orders = (yield* client.query(myOrders("u1"))).map((row) => row.value as Order);
        expect(orders).toHaveLength(1);
        expect(orders[0]!.totalCents).toBe(2 * 14900);
        expect(orders[0]!.status).toBe("placed");
        expect(yield* client.query(myCartItems("u1"))).toEqual([]);
        expect(yield* client.query(myOrderItems("u1"))).toHaveLength(1);

        const variant = (yield* client.query(allVariants)).find((row) => row.id === "v-01a");
        expect((variant?.value as Variant).stock).toBe(10); // 12 - 2
      })
    )
  );
});
