/**
 * The JSON:API façade (ADR-0029, #166) as this app builds it: a plain
 * `fetch()` of a catalog or account URL, answered from the worker's replica
 * when the shell's pins cover it. The worker composes it first in its
 * `fetch` listener (src/service-worker.ts); this module only says what the
 * façade is built from.
 *
 * **The routes.** `server/jsonapi.ts` declares the api the façade must
 * reflect, but that module pulls in the SQL runtime and cannot load in a
 * worker, so its read routes — one `list` per resource the server lists,
 * plus the product `get` — are restated here under the same `/jsonapi`
 * prefix, method and path being all route reflection reads. A route that is
 * not served by the server must not appear here: the façade would answer a
 * URL the server never would.
 *
 * **The declarations.** Linkage follows the resources the server's
 * endpoints are declared with (`server/resources.ts`, worker-safe), so a
 * locally served document carries exactly the relationships the server
 * writes (ADR-0029 §6; `tests/replica-documents.test.ts` checks the bytes).
 */
import { type Effect, Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { Resource } from "@thomasfosterau/effect-jsonapi";
import type { Query } from "@legation/effect";
import type { ClientView, Coverage } from "@legation/effect/internal";
import { JsonApiFacade } from "@legation/jsonapi";
import {
  CartItem,
  Category,
  Order,
  OrderItem,
  Product,
  Review,
  Seller,
  Variant,
} from "../../server/resources.js";
import { nodes } from "./domain.js";

const open = { success: Schema.Unknown };

/** The server's read routes (`server/jsonapi.ts`), restated for reflection. */
export const readRoutes = HttpApi.make("commerce-reads")
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
      .add(HttpApiEndpoint.get("reviews", "/reviews", open))
  )
  .add(
    HttpApiGroup.make("account")
      .add(HttpApiEndpoint.get("cartItems", "/cartItems", open))
      .add(HttpApiEndpoint.get("orders", "/orders", open))
      .add(HttpApiEndpoint.get("orderItems", "/orderItems", open))
  )
  .prefix("/jsonapi");

/** The resource declarations the server's endpoints carry, by type. */
export const resources: ReadonlyMap<string, Resource.Any> = new Map(
  [Category, Seller, Product, Variant, Review, CartItem, Order, OrderItem].map((resource) => [
    resource.type,
    resource,
  ])
);

/** What the façade reads: the replica, its ledger's verdict, and its cookie. */
export interface FacadeSource {
  /** The replica: `ClientView.fromEngine(engine)` in the worker, `client.view` in a test. */
  readonly view: ClientView.Reader;
  /** The ledger: the host's registrations in the worker, `client.coverageOf` in a test. */
  readonly coverageOf: (read: Query.Read) => Effect.Effect<Coverage.Verdict>;
  /** The replica's CVR cookie (`store.getCookie`), for `x-legation-served-at`. */
  readonly cookie: Effect.Effect<string | undefined, unknown>;
  /** Connectivity; defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
}

/** The façade over this app's routes and declarations. */
export const makeFacade = (source: FacadeSource): JsonApiFacade.FetchHandler =>
  JsonApiFacade.fetchHandler({ nodes, api: readRoutes, resources, ...source });
