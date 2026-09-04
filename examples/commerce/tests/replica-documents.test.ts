/**
 * Same URL, same result (ADR-0029 §6, issue #164): for the commerce seed and
 * every read the app declares (`src/lib/domain.ts` — the shell pins and the
 * page reads), the document the replica-side writer (`ReplicaDocuments`)
 * produces from a synced replica equals, byte for byte, the document the
 * derived REST handler (`RestHandlers`, #163) produces from the SQLite
 * server for the same URL under the same resource declarations
 * (`server/resources.ts`). The host never appears in `links.self` on either
 * side (both prefix `/jsonapi`), so nothing is ignored.
 *
 * Two worlds over one seed: the SQLite server as `derived-rest.test.ts`
 * stands it up (migration, private rows for two users), and a
 * `MemoryBackend` loaded with the same tables behind a `Server` whose
 * identity resolver binds the replica's client group to `u1`, synced into an
 * owned engine by the shell's own pins (`shellReads("u1")`). The replica
 * holds what a signed-in user's shell holds; the writer reads it as the
 * façade would — and the façade itself (`src/lib/facade.ts`, #166) is then
 * run over the same replica: a covered URL's response body is the served
 * document byte for byte, an uncovered one is the network's.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Resource } from "@thomasfosterau/effect-jsonapi";
import { Client, ClientStore, MemoryBackend, type Query, Server, Transport } from "@legation/effect";
import { ClientEngine, ClientView } from "@legation/effect/internal";
import { JsonApiQuery, ReplicaDocuments, RestHandlers } from "@legation/jsonapi";
import {
  allCategories,
  mutators,
  nodes,
  productDetail,
  productPage,
  productReviews,
  shellReads,
} from "../src/lib/domain.js";
import { makeFacade } from "../src/lib/facade.js";
import { migrate } from "../server/db.js";
import { NotFound } from "../server/jsonapi.js";
import {
  CartItem,
  Category,
  Order,
  OrderItem,
  Product,
  Review,
  Seller,
  Variant,
} from "../server/resources.js";
import { authPolicy, CommerceSync, syncLayer } from "../server/runtime.js";
import { tables } from "../server/handlers.js";

// ─── The declarations both sides write under ─────────────────────────────────

/** The app's REST contract declares no profiles resource; the replica-side read needs one. */
const Profile = Resource.make("profiles", { attributes: { name: Schema.String } });

const resources = new Map<string, Resource.Any>(
  [Category, Seller, Product, Variant, Review, CartItem, Order, OrderItem, Profile].map(
    (resource) => [resource.type, resource]
  )
);

// ─── The derived REST api: one open endpoint per collection the reads name ──

const open = { success: Schema.Unknown };
const derivedApi = HttpApi.make("derived")
  .add(
    HttpApiGroup.make("catalog")
      .add(HttpApiEndpoint.get("categories", "/categories", open))
      .add(HttpApiEndpoint.get("sellers", "/sellers", open))
      .add(HttpApiEndpoint.get("products", "/products", open))
      .add(
        HttpApiEndpoint.get("product", "/products/:id", {
          params: Schema.Struct({ id: Schema.String }),
          error: NotFound.wire,
          ...open,
        })
      )
      .add(HttpApiEndpoint.get("variants", "/variants", open))
      .add(HttpApiEndpoint.get("reviews", "/reviews", open))
  )
  .add(
    HttpApiGroup.make("account")
      .add(HttpApiEndpoint.get("cartItems", "/cartItems", open))
      .add(HttpApiEndpoint.get("orders", "/orders", open))
      .add(HttpApiEndpoint.get("orderItems", "/orderItems", open))
      .add(HttpApiEndpoint.get("profiles", "/profiles", open))
  )
  .prefix("/jsonapi");

const derivedLive = (rest: RestHandlers.RestHandlers) =>
  Layer.mergeAll(
    HttpApiBuilder.group(derivedApi, "catalog", (handlers) =>
      handlers
        .handle("categories", rest.list(Category))
        .handle("sellers", rest.list(Seller))
        .handle("products", rest.list(Product))
        .handle("product", rest.get(Product, { notFound: () => new NotFound() }))
        .handle("variants", rest.list(Variant))
        .handle("reviews", rest.list(Review))
    ),
    HttpApiBuilder.group(derivedApi, "account", (handlers) =>
      handlers
        .handle("cartItems", rest.list(CartItem))
        .handle("orders", rest.list(Order))
        .handle("orderItems", rest.list(OrderItem))
        .handle("profiles", rest.list(Profile))
    )
  );

// ─── The worlds ──────────────────────────────────────────────────────────────

type Json = any;

const USER = "u1";
const GROUP = "group-u1";

/** Every table's rows as the sync tier ships them, read back off the migrated database. */
const seedRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows: Array<{ readonly collection: string; readonly value: { readonly id: string } }> = [];
  for (const [collection, mapping] of Object.entries(tables)) {
    const values = yield* sql.unsafe<{ id: string }>(`SELECT * FROM ${mapping.table}`);
    for (const value of values) rows.push({ collection, value });
  }
  return rows;
});

/** The SQLite server and its derived REST handlers, served in-process. */
const makeRest = Effect.gen(function* () {
  const context = yield* Layer.build(
    syncLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  );
  const sql = Context.get(context, SqlClient);
  yield* migrate.pipe(Effect.provideService(SqlClient, sql));
  // Private rows for two users, so the replica's scoping has something to hide.
  yield* sql`INSERT INTO profiles (id, name) VALUES ('u1', 'Ursula'), ('u2', 'Umberto')`;
  yield* sql`INSERT INTO cartItems (id, userId, variantId, qty)
    VALUES ('ci-1', 'u1', 'v-01a', 2), ('ci-2', 'u1', 'v-03a', 1), ('ci-3', 'u2', 'v-02a', 1)`;
  yield* sql`INSERT INTO orders (id, userId, status, totalCents, createdAt)
    VALUES ('o-1', 'u1', 'placed', 29800, '2026-07-01T00:00:00Z'),
           ('o-2', 'u1', 'shipped', 12900, '2026-07-02T00:00:00Z'),
           ('o-3', 'u2', 'placed', 9900, '2026-07-03T00:00:00Z')`;
  yield* sql`INSERT INTO orderItems (id, orderId, userId, variantId, qty, priceCents)
    VALUES ('o-1-0', 'o-1', 'u1', 'v-01a', 2, 14900), ('o-2-0', 'o-2', 'u1', 'v-03a', 1, 12900),
           ('o-3-0', 'o-3', 'u2', 'v-02a', 1, 9900)`;

  const rest = RestHandlers.make({
    nodes,
    backend: Context.get(context, CommerceSync).backend,
    policy: authPolicy,
    context: (request) => {
      const user = request.headers["x-commerce-user"];
      return Effect.succeed({
        clientGroupId: "http",
        ...(typeof user === "string" && user.length > 0 ? { identity: user } : {}),
      });
    },
    prefix: "/jsonapi",
  });
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(derivedApi).pipe(
          Layer.provide(derivedLive(rest)),
          Layer.provide(HttpServer.layerServices)
        ) as Layer.Layer<never, never, HttpRouter.HttpRouter>,
        { disableLogger: true }
      )
    ),
    ({ dispose }) => Effect.promise(dispose)
  );
  const fetch = (path: string) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://commerce.test${path}`, {
          headers: { accept: "application/vnd.api+json", "x-commerce-user": USER },
        })
      );
      return { status: response.status, body: (await response.json()) as Json };
    });
  const rows = yield* seedRows.pipe(Effect.provideService(SqlClient, sql));
  return { fetch, rows };
});

/** The same rows in a `MemoryBackend` behind a `Server`, synced into an owned engine by the shell's pins. */
const makeReplica = (rows: ReadonlyArray<{ readonly collection: string; readonly value: Json }>) =>
  Effect.gen(function* () {
    const backend = yield* MemoryBackend.make({
      "seed/put": (args, writer) => {
        const { collection, value } = args as { collection: string; value: { id: string } };
        return writer.put(collection, value.id, value);
      },
    });
    yield* backend.applyMutations(
      { clientGroupId: "seed" },
      rows.map((args, index) => ({
        clientId: "seed",
        mutationId: index + 1,
        mutator: "seed/put",
        args,
        createdAt: 0,
      }))
    );
    const server = yield* Server.make({
      backend,
      auth: {
        policy: authPolicy,
        // The replica's client group is the signed-in user's (the `client_groups` binding).
        identity: { resolve: (group) => Effect.succeed(group === GROUP ? USER : undefined) },
      },
    });
    const transport = yield* Transport.makeInMemory(server.handler, GROUP);
    const store = yield* ClientStore.makeMemory;
    const engine = yield* ClientEngine.make({
      clientId: "client-u1",
      clientGroupId: GROUP,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    const view = ClientView.fromEngine(engine);
    const client = Client.fromView(nodes, view);
    yield* Effect.forEach(shellReads(USER), (read) => client.subscribe(read), { discard: true });
    yield* engine.pull;
    return { view, client, store };
  });

const makeWorlds = Effect.gen(function* () {
  const rest = yield* makeRest;
  const replica = yield* makeReplica(rest.rows);
  const docs = ReplicaDocuments.make({ nodes, resources, prefix: "/jsonapi" });
  return { ...rest, ...replica, docs };
});

const bytes = (document: unknown) => JSON.stringify(document);

// ─── The reads the app declares ──────────────────────────────────────────────

const reads: ReadonlyArray<{ readonly name: string; readonly read: Query.Read }> = [
  ...shellReads(USER).map((read, index) => ({ name: `shell read ${index + 1}`, read })),
  { name: "productDetail", read: productDetail("p-01") },
  { name: "productPage", read: productPage({}) },
  { name: "productPage in a category", read: productPage({ categoryId: "c-keyboards" }) },
  { name: "productPage after a cursor", read: productPage({ cursor: "p-02", limit: 2 }) },
  { name: "productReviews", read: productReviews("p-03") },
];

describe("the replica-side writer against the derived REST handler (ADR-0029 §6)", () => {
  it.effect("writes every declared read's document byte for byte as the server does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fetch, view, docs } = yield* makeWorlds;
        for (const { name, read } of reads) {
          const url = `/jsonapi${JsonApiQuery.canonical(nodes, read)}`;
          const served = yield* fetch(url);
          expect(served.status, name).toBe(200);
          expect(served.body.data, name).not.toEqual([]);
          const local = yield* docs.collection(view, { read });
          expect(bytes(local), `${name}: ${url}`).toBe(bytes(served.body));
        }
      })
    )
  );

  it.effect("serves a URL as the façade would: one row by path, fields[] projected, links intact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fetch, view, docs } = yield* makeWorlds;
        for (const url of [
          "/jsonapi/products/p-01?include=variants",
          "/jsonapi/products?fields[products]=name&include=variants&sort=id",
          "/jsonapi/products?sort=id&page[limit]=4",
          "/jsonapi/cartItems?include=variant",
        ]) {
          const served = yield* fetch(url);
          const local = yield* docs.fromUrl(view, url);
          expect(bytes(local), url).toBe(bytes(served.body));
        }
        // `fields[products]=name&include=variants`: only `name`, full linkage
        // to every included variant, the variants themselves full.
        const projected = (yield* docs.fromUrl(
          view,
          "/jsonapi/products?fields[products]=name&include=variants&sort=id"
        )) as Json;
        expect(projected.data).toHaveLength(6);
        const linked = new Set<string>();
        for (const product of projected.data) {
          expect(Object.keys(product.attributes)).toEqual(["name"]);
          for (const identifier of product.relationships.variants.data) linked.add(identifier.id);
        }
        expect(projected.included).toHaveLength(9);
        expect(projected.included.every((variant: Json) => linked.has(variant.id))).toBe(true);
        expect(Object.keys(projected.included[0].attributes)).toEqual([
          "sku",
          "name",
          "priceCents",
          "stock",
        ]);
        // The next link continues the window through the parser, on both sides.
        const first = (yield* docs.fromUrl(view, "/jsonapi/products?sort=id&page[limit]=4")) as Json;
        expect(first.links.next).toBe("/jsonapi/products?sort=id&page[limit]=4&page[after]=p-04");
        const second = (yield* docs.fromUrl(view, first.links.next)) as Json;
        expect(second.data.map((product: Json) => product.id)).toEqual(["p-05", "p-06"]);
        expect(bytes(second)).toBe(bytes((yield* fetch(first.links.next)).body));
      })
    )
  );

  it.effect("names the reads the shell's pins must cover, and the shell covers them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, docs } = yield* makeWorlds;
        // `Product` declares `variants` many: a products listing needs the
        // variants collection whole beside its own read — which the shell pins.
        const page = productPage({});
        expect(yield* docs.toCover(page)).toEqual([page, { collection: "variants" }]);
        for (const read of yield* docs.toCover(page)) {
          expect((yield* client.coverageOf(read))._tag, JSON.stringify(read)).toBe("Covered");
        }
        // A category-narrowed page over the windowed products pin is ADR-0029's
        // strict-window row 2: not covered, so the façade sends it to the network.
        expect((yield* client.coverageOf(productPage({ categoryId: "c-keyboards" })))._tag).toBe(
          "Uncovered"
        );
        // Declarations without a `many` relationship need nothing beyond the read.
        expect(yield* docs.toCover(allCategories)).toEqual([allCategories]);
      })
    )
  );
});

// ─── The façade over the same replica (#166) ─────────────────────────────────

const jsonApi = (url: string) =>
  new Request(`http://commerce.test${url}`, { headers: { accept: "application/vnd.api+json" } });

describe("the commerce façade against the derived REST handler (ADR-0029 §6)", () => {
  it.effect("answers a covered URL with the served document's bytes, and forwards the rest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fetch, client, store } = yield* makeWorlds;
        const online = { current: true };
        const facade = makeFacade({
          view: client.view,
          coverageOf: client.coverageOf,
          cookie: store.getCookie,
          online: () => online.current,
        });
        const urlOf = (read: Query.Read) => `/jsonapi${JsonApiQuery.canonical(nodes, read)}`;
        // What the shell's pins cover (ADR-0029 §3), as plain fetches of the
        // URLs: the pins themselves (the api lists no sellers or profiles, so
        // the façade, reflecting it, has no such routes), a prefix of the
        // products window, a projection over it, and the reviews of one
        // product under the unwindowed reviews pin.
        const local = [
          ...shellReads(USER)
            .filter((read) => !["sellers", "profiles"].includes(read.collection))
            .map(urlOf),
          urlOf(productPage({})),
          urlOf(productReviews("p-03")),
          "/jsonapi/products?fields[products]=name&sort=id&page[limit]=3",
        ];
        for (const url of local) {
          const request = jsonApi(url);
          expect(facade.matches(request), url).toBe(true);
          const response = yield* facade.handle(request);
          expect(response, url).toBeDefined();
          expect(response!.status, url).toBe(200);
          expect(response!.headers.get("cache-control"), url).toBe("no-store");
          expect(response!.headers.get("x-legation-served-at"), url).toBe(yield* store.getCookie);
          const served = yield* fetch(url);
          expect(bytes(yield* Effect.promise(() => response!.json())), url).toBe(bytes(served.body));
        }
        // What they do not: a narrower predicate or another cursor over the
        // windowed products pin (rule 2, the strict window — `productDetail`
        // and a single product by path included), and every user's cart items
        // when the pin holds one user's (rule 3). The network's, unchanged.
        const narrowed = urlOf(productPage({ categoryId: "c-keyboards" }));
        const network = [
          narrowed,
          urlOf(productPage({ cursor: "p-02", limit: 2 })),
          urlOf(productDetail("p-01")),
          "/jsonapi/products/p-01",
          "/jsonapi/cartItems?include=variant",
        ];
        for (const url of network) {
          const request = jsonApi(url);
          expect(facade.matches(request), url).toBe(true);
          expect(yield* facade.handle(request), url).toBeUndefined();
        }
        // Offline, the same uncovered URL is the 503 `offline` document.
        online.current = false;
        expect((yield* facade.handle(jsonApi(narrowed)))!.status).toBe(503);
        // The page's own reads (the app shell, its assets) are never the façade's.
        expect(facade.matches(new Request("http://commerce.test/product/p-01"))).toBe(false);
        expect(facade.matches(new Request("http://commerce.test/sync"))).toBe(false);
      })
    )
  );
});
