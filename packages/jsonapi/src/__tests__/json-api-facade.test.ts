/**
 * JsonApiFacade tests (#166, ADR-0029): the fetch handler over a real
 * replica — a `MemoryBackend` behind a `Server`, synced into an owned engine
 * over an in-memory transport, read through a `Client` whose ledger is the
 * façade's coverage source — with a routes-only `HttpApi` for reflection.
 * Covered requests are answered locally and byte-equal to the replica-side
 * writer's document (the writer's parity with the derived REST handler is
 * `replica-documents.test.ts`'s); uncovered ones fall through, or become
 * the 503 `offline` document when the network is unreachable; a URL the
 * grammar rejects is the codec's 400; and everything that is not a JSON:API
 * `GET` on a reflected route is not the façade's business.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, type Scope } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Authorization,
  Client,
  ClientStore,
  Edge,
  MemoryBackend,
  Mutator,
  Node,
  QueryError,
  Server,
  Transport,
} from "@legation/effect";
import { ClientEngine, ClientView } from "@legation/effect/internal";
import * as JsonApiFacade from "../JsonApiFacade.js";
import * as JsonApiQuery from "../JsonApiQuery.js";
import * as ReplicaDocuments from "../ReplicaDocuments.js";
import * as RestHandlers from "../RestHandlers.js";

// ─── The graph ───────────────────────────────────────────────────────────────

const categories = Node.make("categories", { attributes: { name: Schema.String } });
const products = Node.make("products", {
  attributes: { name: Schema.String, priceCents: Schema.Number },
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    variants: Edge.many("variants", { inverse: "product" }),
  },
  filterable: { priceCents: ["gt", "lt"] },
  sortable: ["name", "priceCents"],
});
const variants = Node.make("variants", {
  attributes: { sku: Schema.String },
  edges: { product: Edge.one("products", { via: "productId" }) },
});
const nodes = Node.registry([categories, products, variants]);

interface SeedRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

const seed: Readonly<Record<string, ReadonlyArray<SeedRow>>> = {
  categories: [
    { id: "c-audio", name: "Audio" },
    { id: "c-desk", name: "Desk" },
  ],
  products: [
    { id: "p-1", categoryId: "c-desk", name: "Desk", priceCents: 300 },
    { id: "p-2", categoryId: "c-audio", name: "Lamp", priceCents: 100 },
    { id: "p-3", categoryId: "c-audio", name: "Chair", priceCents: 200 },
  ],
  variants: [
    { id: "v-1", productId: "p-1", sku: "DSK-1" },
    { id: "v-2", productId: "p-1", sku: "DSK-2" },
    { id: "v-3", productId: "p-2", sku: "LMP-1" },
  ],
};

// ─── The api the façade reflects: read routes only, mounted at /jsonapi ─────

const open = { success: Schema.Unknown };
const api = HttpApi.make("shop")
  .add(
    HttpApiGroup.make("catalog")
      .add(HttpApiEndpoint.get("categories", "/categories", open))
      .add(HttpApiEndpoint.get("products", "/products", open))
      .add(
        HttpApiEndpoint.get("product", "/products/:id", {
          params: Schema.Struct({ id: Schema.String }),
          ...open,
        })
      )
      .add(HttpApiEndpoint.get("variants", "/variants", open))
      // A server-only resource: no node reads it, so the façade never answers it.
      .add(HttpApiEndpoint.get("promotions", "/promotions", open))
      .add(
        HttpApiEndpoint.get("promotion", "/promotions/:id", {
          params: Schema.Struct({ id: Schema.String }),
          ...open,
        })
      )
  )
  .prefix("/jsonapi");

// ─── The replica ─────────────────────────────────────────────────────────────

const ProductRename = Schema.Struct({ id: Schema.String, name: Schema.String });
const productRename = Mutator.make("product/rename", ProductRename);
const mutators = Mutator.registry([
  {
    mutator: productRename,
    local: (args, writer) =>
      Effect.flatMap(writer.get("products", args.id), (current) =>
        current === undefined
          ? Effect.void
          : writer.put("products", args.id, { ...(current as SeedRow), name: args.name })
      ),
  },
]);

const GROUP = "group-a";

/** The seed behind a `Server`, synced into an owned engine read through a `Client`. */
const makeReplica = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make({
    "seed/put": (args, writer) => {
      const { collection, value } = args as { collection: string; value: { id: string } };
      return writer.put(collection, value.id, value);
    },
  });
  const puts = Object.entries(seed).flatMap(([collection, rows]) =>
    rows.map((value) => ({ collection, value }))
  );
  yield* backend.applyMutations(
    { clientGroupId: "seed" },
    puts.map((args, index) => ({
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
      policy: Authorization.policy(
        Object.fromEntries([...nodes.nodes.keys()].map((name) => [name, Authorization.allowAll])),
        { collections: nodes.collections }
      ),
    },
  });
  const transport = yield* Transport.makeInMemory(server.handler, GROUP);
  const store = yield* ClientStore.makeMemory;
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: GROUP,
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  const view = ClientView.fromEngine(engine);
  const client = Client.fromView(nodes, view, { urls: JsonApiQuery.urlReads(nodes) });
  return { client, engine, store };
});

interface Facade {
  readonly handler: JsonApiFacade.FetchHandler;
  readonly client: Client.Client;
  readonly engine: ClientEngine.ClientEngine;
  readonly docs: ReplicaDocuments.ReplicaDocuments;
  readonly online: { current: boolean };
}

/** A façade over the replica, with the shell's pins applied and pulled. */
const makeFacade = (
  pins: ReadonlyArray<string>,
  options: Partial<Pick<JsonApiFacade.Options<string, never>, "baseUrl">> = {}
): Effect.Effect<Facade, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { client, engine, store } = yield* makeReplica;
    for (const url of pins) yield* client.subscribe(url);
    yield* engine.pull;
    const online = { current: true };
    const handler = JsonApiFacade.fetchHandler({
      nodes,
      api,
      view: client.view,
      coverageOf: client.coverageOf,
      cookie: store.getCookie,
      online: () => online.current,
      ...options,
    });
    const docs = ReplicaDocuments.make({ nodes, prefix: "/jsonapi" });
    return { handler, client, engine, docs, online };
  }).pipe(Effect.orDie);

const jsonApi = (url: string, init: RequestInit = {}): Request =>
  new Request(new URL(url, "http://shop.test"), {
    headers: { accept: "application/vnd.api+json" },
    ...init,
  });

const bytes = (document: unknown) => JSON.stringify(document);

const body = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("JsonApiFacade", () => {
  it.effect("answers a covered request from the replica, byte-equal to the writer's document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, client, docs } = yield* makeFacade([
          "/jsonapi/products?include=variants",
          "/jsonapi/variants",
        ]);
        const url = "/jsonapi/products?filter[categoryId]=c-audio&sort=-name&include=variants";
        const request = jsonApi(url);
        expect(handler.matches(request)).toBe(true);
        const response = yield* handler.handle(request);
        expect(response).toBeDefined();
        expect(response!.status).toBe(200);
        expect(response!.headers.get("content-type")).toBe("application/vnd.api+json");
        expect(response!.headers.get("cache-control")).toBe("no-store");
        // The replica pulled once: the header carries its CVR cookie.
        const cookie = response!.headers.get(JsonApiFacade.servedAtHeader);
        expect(cookie).not.toBeNull();
        expect(cookie!.length).toBeGreaterThan(0);
        const local = yield* docs.fromUrl(client.view, url);
        expect(bytes(yield* body(response!))).toBe(bytes(local));
        // The rows themselves: audio products by name descending, with linkage.
        const document = local as { data: ReadonlyArray<{ id: string }> };
        expect(document.data.map((row) => row.id)).toEqual(["p-2", "p-3"]);
      })
    )
  );

  it.effect("serves a single resource by path, and forwards one the replica does not hold", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, client, docs } = yield* makeFacade([
          "/jsonapi/products",
          "/jsonapi/variants",
        ]);
        const found = yield* handler.handle(jsonApi("/jsonapi/products/p-1"));
        expect(found!.status).toBe(200);
        const local = yield* docs.fromUrl(client.view, "/jsonapi/products/p-1");
        expect(bytes(yield* body(found!))).toBe(bytes(local));
        // Covered, but no such row: the 404 is the endpoint's own, so the
        // server writes it.
        expect(yield* handler.handle(jsonApi("/jsonapi/products/p-9"))).toBeUndefined();
      })
    )
  );

  it.effect("sees a pending optimistic write in a covered response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, client } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
        yield* client.mutate("product/rename", { id: "p-1", name: "Standing desk" });
        const response = yield* handler.handle(jsonApi("/jsonapi/products/p-1"));
        const document = (yield* body(response!)) as { data: { attributes: { name: string } } };
        // The same view `Client.query` reads: the journal's overlay is visible
        // before any push, as ADR-0029 §4 documents for covered requests.
        expect(document.data.attributes.name).toBe("Standing desk");
      })
    )
  );

  it.effect("forwards an uncovered request unchanged while online", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A windowed pin: a narrower request over it is ADR-0029's strict-window row 2.
        const { handler } = yield* makeFacade([
          "/jsonapi/products?sort=name&page[limit]=2",
          "/jsonapi/variants",
        ]);
        const request = jsonApi(
          "/jsonapi/products?filter[categoryId]=c-audio&sort=name&page[limit]=2"
        );
        expect(handler.matches(request)).toBe(true);
        expect(yield* handler.handle(request)).toBeUndefined();
        // A prefix of the identical window is covered.
        const covered = yield* handler.handle(jsonApi("/jsonapi/products?sort=name&page[limit]=1"));
        expect(covered!.status).toBe(200);
        // A category listing with no pin at all: the network's.
        expect(yield* handler.handle(jsonApi("/jsonapi/categories"))).toBeUndefined();
      })
    )
  );

  it.effect(
    "covers an offset-paginated read by slicing a subsuming subscription (#209), byte-equal to the writer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, client, docs } = yield* makeFacade([
            "/jsonapi/products?sort=name&page[limit]=2",
            "/jsonapi/variants",
          ]);
          const url = "/jsonapi/products?sort=name&page[offset]=0&page[limit]=2";
          const response = yield* handler.handle(jsonApi(url));
          expect(response!.status).toBe(200);
          const local = yield* docs.fromUrl(client.view, url);
          // The byte-equal comparison above is honest about what it checks:
          // the document writer emits no `meta` yet (a total count is #210),
          // so "same URL, same result" here compares the members the writer
          // emits today (data, included, links) — not a total this document
          // does not carry. Once #210 lands, this gap closes on both sides
          // at once, since both call the one writer.
          const document = local as { data: ReadonlyArray<{ id: string }>; meta?: unknown };
          expect(document.meta).toBeUndefined();
          expect(bytes(yield* body(response!))).toBe(bytes(local));
          expect(document.data.map((row) => row.id)).toEqual(["p-3", "p-1"]);
        })
      )
  );

  it.effect(
    "an offset beyond the synced window falls through — never a deeper fetch to satisfy it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler } = yield* makeFacade([
            "/jsonapi/products?sort=name&page[limit]=2",
            "/jsonapi/variants",
          ]);
          // The pinned window holds 2 rows; offset 2 + limit 2 needs 4, which
          // it does not satisfy — the coverage rule reads an offset read as
          // the ordinary limit-prefix check on offset + first.
          const deep = jsonApi("/jsonapi/products?sort=name&page[offset]=2&page[limit]=2");
          expect(yield* handler.handle(deep)).toBeUndefined();
          // Offline, the same uncovered read is the spec 503 document, never
          // a partial page synthesised from what happens to be synced.
          const { handler: offlineHandler, online } = yield* makeFacade([
            "/jsonapi/products?sort=name&page[limit]=2",
            "/jsonapi/variants",
          ]);
          online.current = false;
          const response = yield* offlineHandler.handle(deep);
          expect(response!.status).toBe(503);
          expect(yield* body(response!)).toEqual(JsonApiFacade.offlineDocument);
        })
      )
  );

  it.effect(
    "an unwindowed subscription covers any offset — the limit-prefix rule needs no upper bound",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler, client, docs } = yield* makeFacade([
            "/jsonapi/products?include=variants",
            "/jsonapi/variants",
          ]);
          const url = "/jsonapi/products?sort=name&page[offset]=1&page[limit]=1";
          const response = yield* handler.handle(jsonApi(url));
          expect(response!.status).toBe(200);
          const local = yield* docs.fromUrl(client.view, url);
          expect(bytes(yield* body(response!))).toBe(bytes(local));
          const document = local as { data: ReadonlyArray<{ id: string }> };
          expect(document.data.map((row) => row.id)).toEqual(["p-1"]);
        })
      )
  );

  it.effect(
    "rejects page[offset] and page[after] together with the codec's 400, same as the server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { handler } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
          const response = yield* handler.handle(
            jsonApi("/jsonapi/products?page[offset]=1&page[after]=p-1")
          );
          expect(response!.status).toBe(400);
          const document = (yield* body(response!)) as {
            errors: ReadonlyArray<{ source?: unknown }>;
          };
          expect(document.errors[0]!.source).toEqual({ parameter: "page[offset]" });
        })
      )
  );

  it.effect("requires every read the linkage needs, not only the URL's own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The products node declares `variants` many: a products listing
        // needs the variants collection whole, which this shell never pinned.
        const { handler } = yield* makeFacade(["/jsonapi/products"]);
        expect(yield* handler.handle(jsonApi("/jsonapi/products"))).toBeUndefined();
      })
    )
  );

  it.effect("answers an uncovered request with the 503 offline document when offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler, online } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
        online.current = false;
        const response = yield* handler.handle(jsonApi("/jsonapi/categories"));
        expect(response!.status).toBe(503);
        expect(response!.headers.get("content-type")).toBe("application/vnd.api+json");
        expect(response!.headers.get("cache-control")).toBe("no-store");
        expect(yield* body(response!)).toEqual({
          errors: [
            {
              status: "503",
              code: "offline",
              title: "Service unavailable",
              detail:
                "The request is not covered by a local subscription and the network is unreachable.",
            },
          ],
        });
        // A covered request is never affected by connectivity.
        const covered = yield* handler.handle(jsonApi("/jsonapi/products/p-2"));
        expect(covered!.status).toBe(200);
        // What a worker answers for a forward that rejected at the transport:
        // the same document, with the replica's current cookie.
        const synthesised = yield* handler.offline;
        expect(synthesised.status).toBe(503);
        expect(synthesised.headers.get(JsonApiFacade.servedAtHeader)).toBe(
          response!.headers.get(JsonApiFacade.servedAtHeader)
        );
        expect(yield* body(synthesised)).toEqual(JsonApiFacade.offlineDocument);
        expect(
          JsonApiFacade.offlineResponse("cookie-1").headers.get(JsonApiFacade.servedAtHeader)
        ).toBe("cookie-1");
      })
    )
  );

  it.effect("answers a URL the grammar rejects with the codec's 400 document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
        const url = "/jsonapi/products?filter[priceCents]=gt:abc";
        const response = yield* handler.handle(jsonApi(url));
        expect(response!.status).toBe(400);
        expect(response!.headers.get("content-type")).toBe("application/vnd.api+json");
        const failure = yield* Effect.flip(JsonApiQuery.parseRead(nodes, url));
        expect(failure).toBeInstanceOf(QueryError);
        expect(yield* body(response!)).toEqual(RestHandlers.queryErrorDocument(failure));
        // Whatever the ledger holds: the server would reject it identically.
        expect((yield* handler.handle(jsonApi("/jsonapi/categories?sort=nope")))!.status).toBe(400);
      })
    )
  );

  it.effect("leaves an include the graph does not declare to the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
        expect(yield* handler.handle(jsonApi("/jsonapi/products?include=reviews"))).toBeUndefined();
      })
    )
  );

  it.effect("is not the business of anything but a JSON:API GET on a reflected route", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"]);
        const passes = [
          // A reflected route whose type is no node: the server's alone, even
          // with a query the grammar could not parse.
          jsonApi("/jsonapi/promotions"),
          jsonApi("/jsonapi/promotions/x?filter[nope]=1"),
          // Not a reflected route: another path, a nested path, a trailing slash, the sync endpoint.
          jsonApi("/api/products"),
          jsonApi("/jsonapi/products/p-1/variants"),
          jsonApi("/jsonapi/products/"),
          jsonApi("/sync"),
          // Not a GET.
          jsonApi("/jsonapi/products", { method: "POST" }),
          // Not asking for JSON:API.
          new Request("http://shop.test/jsonapi/products", { headers: { accept: "text/html" } }),
          new Request("http://shop.test/jsonapi/products", { headers: { accept: "*/*" } }),
          new Request("http://shop.test/jsonapi/products"),
        ];
        for (const request of passes) {
          expect(handler.matches(request), request.url).toBe(false);
          expect(yield* handler.handle(request), request.url).toBeUndefined();
        }
        // Accept lists and parameters are read as media types.
        expect(
          handler.matches(
            new Request("http://shop.test/jsonapi/products", {
              headers: { accept: "text/html, application/vnd.api+json; ext=x" },
            })
          )
        ).toBe(true);
      })
    )
  );

  it.effect("matches under the base URL it is given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const origin = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"], {
          baseUrl: "https://api.shop.test",
        });
        expect(origin.handler.matches(jsonApi("https://api.shop.test/jsonapi/products"))).toBe(
          true
        );
        expect(origin.handler.matches(jsonApi("http://shop.test/jsonapi/products"))).toBe(false);
        const served = yield* origin.handler.handle(
          jsonApi("https://api.shop.test/jsonapi/products")
        );
        expect(served!.status).toBe(200);
        // Links keep the route's own prefix: the server mounts the api as declared.
        const document = (yield* body(served!)) as { links: { self: string } };
        expect(document.links.self).toBe("/jsonapi/products");

        const proxied = yield* makeFacade(["/jsonapi/products", "/jsonapi/variants"], {
          baseUrl: "/proxy/",
        });
        expect(proxied.handler.matches(jsonApi("/proxy/jsonapi/products"))).toBe(true);
        expect(proxied.handler.matches(jsonApi("/jsonapi/products"))).toBe(false);
        expect(proxied.handler.matches(jsonApi("/proxyjsonapi/products"))).toBe(false);
      })
    )
  );

  it.effect("carries an empty served-at header until the replica has pulled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, store } = yield* makeReplica;
        yield* client.subscribe("/jsonapi/categories");
        const handler = JsonApiFacade.fetchHandler({
          nodes,
          api,
          view: client.view,
          coverageOf: client.coverageOf,
          cookie: store.getCookie,
          online: () => true,
        });
        const response = yield* handler.handle(jsonApi("/jsonapi/categories"));
        expect(response!.status).toBe(200);
        expect(response!.headers.get(JsonApiFacade.servedAtHeader)).toBe("");
        expect((yield* body(response!)) as { data: unknown }).toEqual({
          data: [],
          links: { self: "/jsonapi/categories" },
        });
      })
    )
  );
});
