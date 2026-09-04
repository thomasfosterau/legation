/**
 * The commerce JSON:API's shape — its endpoints and wire error classes,
 * no handlers, no SQL — in a module both sides of the app can load: the
 * server (`server/jsonapi.ts` binds the handlers) and the service worker
 * (`src/lib/facade.ts` reflects the read routes for the façade, ADR-0029).
 * One declaration, so the routes the façade answers are the routes the
 * server serves, by construction.
 *
 * Each read endpoint declares its query as the node graph's own codec
 * (`JsonApiQuery.querySchema` for a `list`, `singleRowSchema` for a `get`),
 * so the contract the api publishes is the grammar the derived handlers
 * parse and the façade parses — the parity the façade presumes.
 */
import { HttpApi } from "effect/unstable/httpapi";
import { ApiError, Endpoint, Group } from "@thomasfosterau/effect-jsonapi";
import { JsonApiQuery } from "@legation/jsonapi";
import { nodes } from "../src/lib/domain.js";
import { CartItem, Category, Order, OrderItem, Product, Review, Variant } from "./resources.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class Unauthorized extends ApiError.make<Unauthorized>()("Unauthorized", {
  status: 401,
  code: "unauthorized",
  title: "Sign in first",
}) {}

export class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
}) {}

// ─── API shape ───────────────────────────────────────────────────────────────

/** A collection's `list` query, as the node graph declares it: the grammar the derived handler parses. */
const query = (collection: string) => JsonApiQuery.querySchema(nodes, collection);

/** A collection's `get` query — `include` and `fields[…]` — from the same graph. */
const singleRowQuery = (collection: string) => JsonApiQuery.singleRowSchema(nodes, collection);

export const api = HttpApi.make("commerce")
  .add(Group.make(Category, Endpoint.list(Category, { query: query("categories") })))
  .add(
    Group.make(
      Product,
      Endpoint.list(Product, { query: query("products") }),
      Endpoint.get(Product, { query: singleRowQuery("products"), errors: [NotFound] })
    )
  )
  // The catalog page reads every variant (`allVariants`) for its stock badges.
  .add(Group.make(Variant, Endpoint.list(Variant, { query: query("variants") })))
  .add(
    Group.make(
      Review,
      Endpoint.list(Review, { query: query("reviews") }),
      Endpoint.create(Review, { errors: [Unauthorized] })
    )
  )
  .add(
    Group.make(
      CartItem,
      Endpoint.list(CartItem, { query: query("cartItems") }),
      Endpoint.create(CartItem, {
        errors: [Unauthorized, ApiError.BadRequest],
      }),
      Endpoint.delete(CartItem, { errors: [Unauthorized] })
    )
  )
  .add(
    Group.make(
      Order,
      Endpoint.list(Order, { query: query("orders") }),
      Endpoint.create(Order, {
        errors: [Unauthorized, ApiError.BadRequest],
      })
    )
  )
  .add(Group.make(OrderItem, Endpoint.list(OrderItem, { query: query("orderItems") })))
  .prefix("/jsonapi");
