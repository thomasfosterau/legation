/**
 * JSON:API resources → engine row seeds.
 *
 * The SSR pages load JSON:API documents (the naive experience). When the
 * sync tier enhances a page, its live hooks want `initial` seeds in the
 * engine's row shape — `{ id, value }` with foreign keys inlined the way
 * the sync collections store them. These mappers translate the resources a
 * load already fetched, so the first client render matches the server
 * markup with zero extra requests.
 *
 * A seed is decoded with its node's row schema (`Node.RowOf`), so it is the
 * row the live read will emit, typed as the hooks type it: the resource's
 * attributes plus, for each of the node's `one` edges, the related
 * resource's id under the edge's key field. A resource that does not make a
 * row is a defect of the load, and fails here rather than in the markup.
 */
import * as Schema from "effect/Schema";
import type { Node } from "@thomasfosterau/legation";
import {
  cartItems,
  categories,
  orderItems,
  orders,
  products,
  reviews,
  sellers,
  variants,
} from "./domain.js";

interface ResourceLike {
  readonly id: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly relationships?: Readonly<
    Record<
      string,
      { readonly data?: { readonly id: string } | ReadonlyArray<{ readonly id: string }> | null }
    >
  >;
}

/** An engine row seed: the node's row and no included edges. */
export interface RowSeed<Value> {
  readonly id: string;
  readonly value: Value;
  readonly related: Record<never, never>;
}

/** The id a to-one relationship names, if the resource carries it. */
const refId = (resource: ResourceLike, name: string): string | undefined => {
  const data = resource.relationships?.[name]?.data;
  return data === null || data === undefined || !("id" in data) ? undefined : data.id;
};

/**
 * The seeds of a node's resources: each resource's id and attributes, with
 * every `one` edge's related id inlined under the edge's `via` field, decoded
 * as the node's row.
 */
const seeds =
  <N extends Node.AnyNode, Value>(node: N, decode: (input: unknown) => Value) =>
  (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed<Value>> =>
    resources.map((resource) => ({
      id: resource.id,
      value: decode({
        [node.id]: resource.id,
        ...resource.attributes,
        ...Object.fromEntries(
          Object.entries(node.edges).flatMap(([name, edge]) => {
            const id = edge.kind === "one" ? refId(resource, name) : undefined;
            return edge.kind === "one" && id !== undefined ? [[edge.via, id]] : [];
          })
        ),
      }),
      related: {},
    }));

export const categoryRows = seeds(categories, Schema.decodeUnknownSync(categories.row));
export const productRows = seeds(products, Schema.decodeUnknownSync(products.row));
export const variantRows = seeds(variants, Schema.decodeUnknownSync(variants.row));
export const sellerRows = seeds(sellers, Schema.decodeUnknownSync(sellers.row));
export const reviewRows = seeds(reviews, Schema.decodeUnknownSync(reviews.row));
export const cartItemRows = seeds(cartItems, Schema.decodeUnknownSync(cartItems.row));
export const orderRows = seeds(orders, Schema.decodeUnknownSync(orders.row));
export const orderItemRows = seeds(orderItems, Schema.decodeUnknownSync(orderItems.row));
