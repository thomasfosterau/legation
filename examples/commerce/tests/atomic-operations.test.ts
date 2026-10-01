/**
 * The atomic operations endpoint (`POST /jsonapi/operations`) over the real
 * stack — the commerce `HttpApi` served in-process as a web handler over the
 * Effect SQL sqlite client, seeded by `migrate`, with the sync server's
 * `broadcast` wired in:
 *
 * - a batch of `add review` + `add cartItem` succeeds atomically, keeping the
 *   client-generated ids; a batch whose second operation violates stock is
 *   rejected whole with one pointer-bearing error and the first add is not
 *   persisted;
 * - a `lid` on an `add` is resolvable by a later `update` in the same batch;
 * - identity comes from the `x-commerce-user` header (401 without it) and
 *   updates only touch the caller's own rows (404 otherwise);
 * - `JsonApiSync.inspect` reports the endpoint as atomic, and a
 *   `JsonApiBackend` in atomic mode pushes three writes as ONE request, while
 *   a mid-batch stock violation is rejected on the wire, resent without the
 *   offending mutation, recorded as `rejected`, and every mutation is
 *   acknowledged — with nothing from the rejected batch persisted before the
 *   resend (#160's contract, end to end against this server).
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { SqlClient } from "effect/sql/SqlClient";
import { Atomic } from "@thomasfosterau/effect-jsonapi";
import type { Backend } from "@legation/effect";
import { JsonApiBackend, JsonApiSync } from "@legation/jsonapi";
import { clientLayer, migrate } from "../server/db.js";
import { api, jsonApiLive } from "../server/jsonapi.js";
import { syncLayer } from "../server/runtime.js";

const BASE_URL = "http://commerce.test";
const OPERATIONS_PATH = "/jsonapi/operations";
/** The seed's review count, the baseline every rollback assertion checks. */
const SEEDED_REVIEWS = 3;

interface Recorded {
  readonly method: string;
  readonly path: string;
  /** `SELECT COUNT(*) FROM reviews` as the request arrived. */
  readonly reviewsBefore: number;
}

/**
 * The sync stack + JSON:API over an in-memory sqlite database, served as a
 * web handler, plus an `HttpClient` that calls it in-process (recording each
 * request and the reviews on disk at that moment).
 */
const makeWorld = Effect.fnUntraced(function* () {
  const infrastructure = syncLayer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(migrate).pipe(Layer.provideMerge(clientLayer(":memory:")))
    )
  );
  const context = yield* Layer.build(infrastructure);
  const sql = Context.get(context, SqlClient);
  // effect-jsonapi's `:id` endpoint declarations leak an `unknown`
  // requirement into their handlers (see server/client.ts); the runtime
  // carries nothing, so narrow it here.
  const app = jsonApiLive.pipe(
    Layer.provide(Layer.succeedContext(context)),
    Layer.provide(HttpServer.layerServices)
  ) as Layer.Layer<never, never, HttpRouter.HttpRouter>;
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose)
  );

  const count = (table: "reviews" | "cartItems") =>
    (table === "reviews"
      ? sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews`
      : sql<{ n: number }>`SELECT COUNT(*) AS n FROM cartItems`
    ).pipe(
      Effect.map((rows) => rows[0]!.n),
      Effect.orDie
    );

  const requests: Array<Recorded> = [];
  const anonymous = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push({
        method: request.method,
        path: url.pathname,
        reviewsBefore: yield* count("reviews"),
      });
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const response = yield* Effect.promise(() => handler(web));
      return HttpClientResponse.fromWeb(request, response);
    })
  );
  const asUser = (userId: string) =>
    anonymous.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("x-commerce-user", userId)));

  return { sql, count, requests, anonymous, asUser };
});

// ─── Raw operation documents ─────────────────────────────────────────────────

const reviewAttributes = (body: string) => ({
  authorName: "Ada",
  rating: 5,
  body,
  createdAt: "2026-09-01T00:00:00Z",
});

const addReview = (identity: { id?: string; lid?: string }, body = "Flat response.") => ({
  op: "add",
  data: {
    type: "reviews",
    ...identity,
    attributes: reviewAttributes(body),
    relationships: { product: { data: { type: "products", id: "p-01" } } },
  },
});

const addCartItem = (identity: { id?: string; lid?: string }, variantId: string, qty: number) => ({
  op: "add",
  data: {
    type: "cartItems",
    ...identity,
    attributes: { qty },
    relationships: { variant: { data: { type: "variants", id: variantId } } },
  },
});

interface ResultsBody {
  readonly "atomic:results": ReadonlyArray<{
    readonly data?: {
      readonly type: string;
      readonly id: string;
      readonly attributes: Record<string, unknown>;
    };
  }>;
}

interface ErrorsBody {
  readonly errors: ReadonlyArray<{
    readonly status?: string;
    readonly title?: string;
    readonly detail?: string;
    readonly source?: { readonly pointer?: string };
  }>;
}

/** POST an `atomic:operations` document with the extension media type. */
const post = (client: HttpClient.HttpClient, operations: ReadonlyArray<unknown>) =>
  Effect.scoped(
    client
      .execute(
        HttpClientRequest.post(`${BASE_URL}${OPERATIONS_PATH}`).pipe(
          HttpClientRequest.bodyText(
            JSON.stringify({ "atomic:operations": operations }),
            Atomic.MEDIA_TYPE
          ),
          HttpClientRequest.setHeaders({ "Content-Type": Atomic.MEDIA_TYPE, Accept: Atomic.MEDIA_TYPE })
        )
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.json, (body): { readonly status: number; readonly body: unknown } => ({
            status: response.status,
            body,
          }))
        )
      )
  ).pipe(Effect.orDie);

describe("atomic operations endpoint", () => {
  it.effect("applies add review + add cartItem atomically, keeping client ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, asUser } = yield* makeWorld();
        const { status, body } = yield* post(asUser("u1"), [
          addReview({ id: "r-batch-1" }),
          addCartItem({ id: "ci-batch-1" }, "v-01a", 2),
        ]);

        expect(status).toBe(200);
        const results = (body as ResultsBody)["atomic:results"];
        expect(results.map((result) => result.data?.id)).toEqual(["r-batch-1", "ci-batch-1"]);
        expect(results[0]!.data?.type).toBe("reviews");
        expect(results[1]!.data?.type).toBe("cartItems");

        // Both rows exist, owned by the header's user — never the payload's.
        const reviews = yield* sql<{ userId: string; body: string }>`
          SELECT userId, body FROM reviews WHERE id = 'r-batch-1'`;
        expect(reviews).toEqual([{ userId: "u1", body: "Flat response." }]);
        const cart = yield* sql<{ userId: string; variantId: string; qty: number }>`
          SELECT userId, variantId, qty FROM cartItems WHERE id = 'ci-batch-1'`;
        expect(cart).toEqual([{ userId: "u1", variantId: "v-01a", qty: 2 }]);
      })
    )
  );

  it.effect("rejects the whole batch on a stock violation; the first add is not persisted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { count, asUser } = yield* makeWorld();
        // v-01b has 3 in stock.
        const { status, body } = yield* post(asUser("u1"), [
          addReview({ id: "r-rolled-back" }),
          addCartItem({ id: "ci-rolled-back" }, "v-01b", 99),
        ]);

        expect(status).toBe(422);
        const { errors } = body as ErrorsBody;
        expect(errors).toHaveLength(1);
        expect(errors[0]!.status).toBe("422");
        expect(errors[0]!.detail).toBe("insufficient stock");
        expect(errors[0]!.source?.pointer).toBe(Atomic.operationPointer(1));

        // The transaction rolled back: the review from operation 0 is gone.
        expect(yield* count("reviews")).toBe(SEEDED_REVIEWS);
        expect(yield* count("cartItems")).toBe(0);
      })
    )
  );

  it.effect("resolves an add's lid in a later update of the same batch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, asUser } = yield* makeWorld();
        const { status, body } = yield* post(asUser("u1"), [
          addReview({ lid: "draft" }, "First draft."),
          {
            op: "update",
            data: { type: "reviews", lid: "draft", attributes: { body: "Edited." } },
          },
        ]);

        expect(status).toBe(200);
        const results = (body as ResultsBody)["atomic:results"];
        expect(results).toHaveLength(2);
        // No client id: the server assigned one and the update found it by lid.
        const id = results[0]!.data?.id;
        expect(id).toMatch(/^r-/);
        expect(results[1]!.data?.id).toBe(id);
        expect(results[1]!.data?.attributes.body).toBe("Edited.");
        const rows = yield* sql<{ body: string; userId: string }>`
          SELECT body, userId FROM reviews WHERE id = ${id!}`;
        expect(rows).toEqual([{ body: "Edited.", userId: "u1" }]);
      })
    )
  );

  it.effect("identity is the header's: 401 without it, 404 for another user's row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { count, anonymous, asUser } = yield* makeWorld();

        const unsigned = yield* post(anonymous, [addReview({ id: "r-anon" })]);
        expect(unsigned.status).toBe(401);
        expect((unsigned.body as ErrorsBody).errors[0]!.source?.pointer).toBe(
          Atomic.operationPointer(0)
        );
        expect((unsigned.body as ErrorsBody).errors[0]!.detail).toBe("not signed in");

        // r-01 is the seed user's review; a batch that passes its own add
        // first still fails as a whole on the foreign update.
        const foreign = yield* post(asUser("u2"), [
          addReview({ id: "r-u2" }),
          { op: "update", data: { type: "reviews", id: "r-01", attributes: { body: "Mine now." } } },
        ]);
        expect(foreign.status).toBe(404);
        expect((foreign.body as ErrorsBody).errors[0]!.source?.pointer).toBe(
          Atomic.operationPointer(1)
        );
        expect(yield* count("reviews")).toBe(SEEDED_REVIEWS);
      })
    )
  );

  it.effect("removes own rows, treats a missing row as a no-op, refuses another user's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { count, asUser } = yield* makeWorld();
        const remove = { op: "remove", ref: { type: "reviews", id: "r-gone" } };
        expect((yield* post(asUser("u1"), [addReview({ id: "r-gone" })])).status).toBe(200);
        expect((yield* post(asUser("u1"), [remove])).status).toBe(200);
        expect(yield* count("reviews")).toBe(SEEDED_REVIEWS);
        // The same batch again (a resend after a lost response) is a no-op, not a 404.
        expect((yield* post(asUser("u1"), [remove])).status).toBe(200);
        // Another user's row is refused, and the batch's earlier add rolls back.
        const foreign = yield* post(asUser("u2"), [
          addReview({ id: "r-u2" }),
          { op: "remove", ref: { type: "reviews", id: "r-01" } },
        ]);
        expect(foreign.status).toBe(404);
        expect((foreign.body as ErrorsBody).errors[0]!.source?.pointer).toBe(
          Atomic.operationPointer(1)
        );
        expect(yield* count("reviews")).toBe(SEEDED_REVIEWS);
      })
    )
  );

  it.effect("places an order from the authoritative cart, clearing it and taking stock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, count, asUser } = yield* makeWorld();
        const order = (identity: { id?: string; lid?: string }) => ({
          op: "add",
          data: {
            type: "orders",
            ...identity,
            attributes: { status: "placed", totalCents: 0, createdAt: "2026-09-01T00:00:00Z" },
          },
        });
        const placed = yield* post(asUser("u1"), [
          addCartItem({ id: "ci-order" }, "v-01a", 2),
          order({ lid: "o1" }),
        ]);
        expect(placed.status).toBe(200);
        const result = (placed.body as ResultsBody)["atomic:results"][1]!.data!;
        expect(result.attributes.totalCents).toBe(2 * 14900);
        expect(yield* count("cartItems")).toBe(0);
        const stock = yield* sql<{ stock: number }>`SELECT stock FROM variants WHERE id = ${"v-01a"}`.pipe(
          Effect.orDie
        );
        expect(stock[0]!.stock).toBe(10);
        // An empty cart cannot be ordered.
        expect((yield* post(asUser("u1"), [order({})])).status).toBe(422);
      })
    )
  );

  it.effect("409 on another user's id; 422 on an unknown or wrong-type lid; update by ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { asUser } = yield* makeWorld();
        const conflict = yield* post(asUser("u2"), [addReview({ id: "r-01" })]);
        expect(conflict.status).toBe(409);
        expect((conflict.body as ErrorsBody).errors[0]!.status).toBe("409");

        const unknown = yield* post(asUser("u1"), [
          { op: "update", data: { type: "reviews", lid: "never", attributes: { body: "x" } } },
        ]);
        expect(unknown.status).toBe(422);
        expect((unknown.body as ErrorsBody).errors[0]!.title).toBe("Unknown lid");

        // A lid stands for the row its add created; it cannot pose as another type.
        const wrongType = yield* post(asUser("u1"), [
          addCartItem({ lid: "x" }, "v-01a", 1),
          {
            op: "add",
            data: {
              type: "reviews",
              attributes: reviewAttributes("Nope"),
              relationships: { product: { data: { type: "products", lid: "x" } } },
            },
          },
        ]);
        expect(wrongType.status).toBe(422);
        expect((wrongType.body as ErrorsBody).errors[0]!.source?.pointer).toBe(
          Atomic.operationPointer(1)
        );

        // `update` may name its target through `ref` instead of `data.id`.
        const byRef = yield* post(asUser("u1"), [
          addReview({ id: "r-ref" }),
          {
            op: "update",
            ref: { type: "reviews", id: "r-ref" },
            data: { type: "reviews", attributes: { body: "By ref." } },
          },
        ]);
        expect(byRef.status).toBe(200);
        expect((byRef.body as ResultsBody)["atomic:results"][1]!.data!.attributes.body).toBe(
          "By ref."
        );
      })
    )
  );
});

// ─── #160: JsonApiBackend in atomic mode against this endpoint ──────────────

const pushContext: Backend.SyncContext = { clientGroupId: "group-u1" };
const mutation = (mutationId: number, mutator: string, args: unknown) => ({
  clientId: "c-u1",
  mutationId,
  mutator,
  args,
  createdAt: 0,
});
const reviewCreate = (id: string) => ({
  type: "reviews",
  id,
  attributes: reviewAttributes(`Pushed ${id}.`),
  relationships: { product: { data: { type: "products", id: "p-01" } } },
});
const cartItemCreate = (id: string, variantId: string, qty: number) => ({
  type: "cartItems",
  id,
  attributes: { qty },
  relationships: { variant: { data: { type: "variants", id: variantId } } },
});

const makeBackend = (client: HttpClient.HttpClient) => {
  const inspected = JsonApiSync.inspect(api);
  return JsonApiBackend.make({
    baseUrl: BASE_URL,
    resources: inspected.resources,
    mutators: inspected.registry.mutators,
    operations: inspected.operations,
    atomic: { path: inspected.atomic!.path },
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
};

describe("JsonApiBackend pushing through the commerce operations endpoint", () => {
  it("is detected as the api's atomic endpoint by JsonApiSync.inspect", () => {
    const inspected = JsonApiSync.inspect(api);
    expect(inspected.atomic).toEqual({
      groupId: "operations",
      name: "operations",
      method: "POST",
      path: OPERATIONS_PATH,
    });
    // No phantom `operations` resource; the writable resources keep their mutators.
    expect(inspected.resources.has("operations")).toBe(false);
    expect(inspected.registry.mutators.has("reviews/create")).toBe(true);
    expect(inspected.registry.mutators.has("cartItems/create")).toBe(true);
  });

  it.effect("pushes three writes as one atomic request and all three rows exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, requests, asUser } = yield* makeWorld();
        const backend = yield* makeBackend(asUser("u1"));

        const result = yield* backend.applyMutations(pushContext, [
          mutation(1, "reviews/create", reviewCreate("r-push-1")),
          mutation(2, "cartItems/create", cartItemCreate("ci-push-1", "v-01a", 2)),
          mutation(3, "reviews/create", reviewCreate("r-push-2")),
        ]);

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: "POST", path: OPERATIONS_PATH });
        expect(result.lastMutationIds).toEqual({ "c-u1": 3 });
        expect(result.rejected).toBeUndefined();

        const reviews = yield* sql<{ id: string; userId: string }>`
          SELECT id, userId FROM reviews WHERE id IN ('r-push-1', 'r-push-2') ORDER BY id`;
        expect(reviews).toEqual([
          { id: "r-push-1", userId: "u1" },
          { id: "r-push-2", userId: "u1" },
        ]);
        const cart = yield* sql<{ id: string; qty: number }>`
          SELECT id, qty FROM cartItems WHERE userId = 'u1'`;
        expect(cart).toEqual([{ id: "ci-push-1", qty: 2 }]);
      })
    )
  );

  it.effect(
    "a stock violation mid-batch is rejected whole, resent without it, and all acknowledged",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sql, count, requests, asUser } = yield* makeWorld();
          const backend = yield* makeBackend(asUser("u1"));

          const result = yield* backend.applyMutations(pushContext, [
            mutation(1, "reviews/create", reviewCreate("r-push-1")),
            mutation(2, "cartItems/create", cartItemCreate("ci-push-1", "v-01b", 99)),
            mutation(3, "reviews/create", reviewCreate("r-push-2")),
          ]);

          // Two round trips to the one endpoint: the rejection, then the resend.
          expect(requests.map((request) => request.path)).toEqual([
            OPERATIONS_PATH,
            OPERATIONS_PATH,
          ]);
          // Nothing from the rejected batch persisted before the resend.
          expect(requests[1]!.reviewsBefore).toBe(SEEDED_REVIEWS);

          expect(result.rejected).toEqual([
            { clientId: "c-u1", mutationId: 2, reason: "insufficient stock" },
          ]);
          expect(result.lastMutationIds).toEqual({ "c-u1": 3 });
          expect(yield* backend.lastMutationIds(pushContext)).toEqual({ "c-u1": 3 });
          expect(result.hints.map((hint) => [hint.collection, [...hint.ids].toSorted()])).toEqual([
            ["reviews", ["r-push-1", "r-push-2"]],
          ]);

          const reviews = yield* sql<{ id: string }>`
            SELECT id FROM reviews WHERE userId = 'u1' ORDER BY id`;
          expect(reviews).toEqual([{ id: "r-push-1" }, { id: "r-push-2" }]);
          expect(yield* count("cartItems")).toBe(0);
        })
      )
  );
});
