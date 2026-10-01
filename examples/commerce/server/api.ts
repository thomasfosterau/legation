/**
 * The commerce JSON:API's shape — its endpoints and wire error classes,
 * no handlers, no SQL — in a module both sides of the app can load: the
 * server (`server/jsonapi.ts` binds the handlers) and the service worker
 * (`src/lib/facade.ts` reflects the read routes for the façade, ADR-0029).
 * One declaration, so the routes the façade answers are the routes the
 * server serves, by construction. The `operations` group is the atomic
 * operations extension over the writable resources (#167), which
 * `JsonApiSync.inspect` detects for `JsonApiBackend`'s batched push.
 *
 * Each read endpoint declares its query as the node graph's own codec
 * (`JsonApiQuery.querySchema` for a `list`, `singleRowSchema` for a `get`),
 * so the contract the api publishes is the grammar the derived handlers
 * parse and the façade parses — the parity the façade presumes.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiSchema } from "effect/http-api";
import { ApiError, Document, Endpoint, Group } from "@thomasfosterau/effect-jsonapi";
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

/**
 * The atomic `operations` endpoint's errors name the failing operation
 * through `source.pointer`; `ApiError.make` carries custom fields under
 * `meta`, not `source`, so the wire shape is declared structurally (any
 * `{ status, wire }` is an `ErrorClass`), one per status. The handler's
 * in-batch failure (`OperationFailed`, in `server/jsonapi.ts`) encodes to
 * one of these. Each is a JSON:API error document at its status,
 * discriminated inside the endpoint's error union by the error object's
 * `status` literal (the same trick `ApiError`'s own wire schemas use), so
 * the four encode to the right response though their documents are alike.
 */
const operationErrorWire = (status: number) =>
  Document.ErrorDocument(
    Schema.Struct({ ...Document.ErrorObject.fields, status: Schema.Literals([String(status)]) })
  ).pipe(
    HttpApiSchema.asJson({ contentType: "application/vnd.api+json" }),
    HttpApiSchema.status(status)
  );

/** No identity for an operation that needs one. */
export const OperationUnauthorized = { status: 401, wire: operationErrorWire(401) } as const;
/** The operation's target row does not exist (or is not the caller's). */
export const OperationNotFound = { status: 404, wire: operationErrorWire(404) } as const;
/** A client-generated id on `add` that names another user's row. */
export const OperationConflict = { status: 409, wire: operationErrorWire(409) } as const;
/** A business rule refused the operation (stock, rating, unsupported op). */
export const OperationRejected = { status: 422, wire: operationErrorWire(422) } as const;

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
  // The atomic operations extension over the writable resources: one
  // request, one transaction, errors per operation (pointer-bearing). Not a
  // `list` / `get` route, so the façade's reflection leaves it to the server.
  .add(
    Group.make(
      "operations",
      Endpoint.operations([Review, CartItem, Order], {
        errors: [OperationUnauthorized, OperationNotFound, OperationConflict, OperationRejected],
      })
    )
  )
  .prefix("/jsonapi");
