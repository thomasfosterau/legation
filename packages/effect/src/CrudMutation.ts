/**
 * CrudMutation
 *
 * The **graph-derived CRUD mutations** (ADR-0030 §5): for every node a graph
 * declares, a `{type}/create`, `{type}/update` and `{type}/delete`
 * {@link Mutation}, whose args are in the **graph row form** — the flat row
 * a node-graph replica stores, attributes and `one`-edge `via` keys side by
 * side — with the client (optimistic) handler that writes it. They are what a
 * plain write means when nobody said otherwise: the JSON:API façade's default
 * intent mapping journals a reflected `POST` / `PATCH` / `DELETE` as one of
 * them (`@thomasfosterau/legation-jsonapi`'s `JsonApiFacade`).
 *
 * Args, for a node `reviews` with an edge `product: Edge.one("products", { via: "productId" })`:
 *
 * - `reviews/create`: `{ type: "reviews", id, attributes }`, `attributes`
 *   holding the row's fields (`productId` among them). The handler puts the
 *   row `{ ...attributes, [node.id]: id }`.
 * - `reviews/update`: the same shape, with only the fields being set. The
 *   handler merges them over the current row and is a **no-op when the row
 *   is absent**, so a patch journaled behind a create that the server later
 *   rejects leaves no phantom row behind (ADR-0030 §2).
 * - `reviews/delete`: `{ type: "reviews", id }`. The handler deletes the row
 *   (a no-op when it is absent).
 *
 * The args schemas are permissive (`attributes` is a record of unknown
 * values), so the encoded and decoded forms coincide and a JSON body can be
 * journaled as decoded. Attribute values are not validated here: the server's
 * handler under the same name is the authority (ADR-0008), and a value it
 * refuses surfaces as a permanent rejection.
 *
 * **Not `Derive.ts`'s mutations.** `@thomasfosterau/legation-jsonapi`'s
 * resource-derived CRUD mutators share these names but store a different row
 * shape (`JsonApiRow`: attributes flat, `relationships` nested, for the
 * client-direct stack with no node graph), and their `update` puts a partial
 * row when the row is absent. An engine registers one family or the other,
 * never both. These are for a replica built from a node graph.
 *
 * The server half is the app's: register a backend handler under each name
 * the client registers, applying the app's own write rules.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Mutator from "./Mutator.js";
import type * as Node from "./Node.js";

/** The three operations a graph-derived mutation performs. */
export type Operation = "create" | "update" | "delete";

/**
 * Which operations to derive, per node type. A type absent from the map gets
 * none; an absent map derives all three for every node.
 */
export type Writes = Readonly<Record<string, ReadonlyArray<Operation>>>;

/** The mutation name for a type and an operation: `"{type}/{operation}"`. */
export const name = (type: string, operation: Operation): string => `${type}/${operation}`;

/** The args of a `{type}/create` or `{type}/update`: the row's fields as a record, keyed by its id. */
export const WriteArgs = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
});

/** The decoded (and encoded) args of a create or an update. */
export type WriteArgs = typeof WriteArgs.Type;

/** The args of a `{type}/delete`. */
export const DeleteArgs = Schema.Struct({ type: Schema.String, id: Schema.String });

/** The decoded (and encoded) args of a delete. */
export type DeleteArgs = typeof DeleteArgs.Type;

/** One derived mutation: its definition, its client handler, and what it does to which type. */
export interface Entry {
  readonly mutator: Mutator.AnyMutator;
  readonly local: Mutator.LocalHandler<any>;
  readonly type: string;
  readonly operation: Operation;
}

/** Options for {@link entries} and {@link registry}. */
export interface Options {
  /** Which operations to derive per type; default all three for every node. */
  readonly writes?: Writes | undefined;
}

const derivesFor = (writes: Writes | undefined, type: string, operation: Operation): boolean =>
  writes === undefined || (writes[type] ?? []).includes(operation);

/** The derived mutations of one node, filtered by `writes`. */
const nodeEntries = (node: Node.AnyNode, writes: Writes | undefined): ReadonlyArray<Entry> => {
  const { type } = node;
  const identity = node.id;
  const entries: Array<Entry> = [];
  if (derivesFor(writes, type, "create")) {
    entries.push({
      type,
      operation: "create",
      mutator: Mutator.make(name(type, "create"), WriteArgs),
      local: (args: WriteArgs, writer) =>
        writer.put(type, args.id, { ...args.attributes, [identity]: args.id }),
    });
  }
  if (derivesFor(writes, type, "update")) {
    entries.push({
      type,
      operation: "update",
      mutator: Mutator.make(name(type, "update"), WriteArgs),
      local: (args: WriteArgs, writer) =>
        Effect.flatMap(writer.get(type, args.id), (current) =>
          current === undefined
            ? Effect.void
            : writer.put(type, args.id, {
                ...(current as Record<string, unknown>),
                ...args.attributes,
                [identity]: args.id,
              })
        ),
    });
  }
  if (derivesFor(writes, type, "delete")) {
    entries.push({
      type,
      operation: "delete",
      mutator: Mutator.make(name(type, "delete"), DeleteArgs),
      local: (args: DeleteArgs, writer) => writer.del(type, args.id),
    });
  }
  return entries;
};

/**
 * The graph-derived CRUD mutations of every node in the graph (those `writes`
 * selects), as registry entries an app spreads beside its own named
 * mutations: `Mutation.registry([...mine, ...CrudMutation.entries(nodes)])`.
 *
 * @example
 * ```ts
 * import * as Schema from "effect/Schema";
 * import { CrudMutation, Edge, Mutation, Node } from "@thomasfosterau/legation-effect";
 *
 * const products = Node.make("products", { attributes: { name: Schema.String } });
 * const reviews = Node.make("reviews", {
 *   attributes: { rating: Schema.Number },
 *   edges: { product: Edge.one("products", { via: "productId" }) },
 * });
 * const nodes = Node.registry([products, reviews]);
 *
 * const registry = Mutation.registry(
 *   CrudMutation.entries(nodes, { writes: { reviews: ["create", "delete"] } })
 * );
 * console.log([...registry.mutators.keys()]); // ["reviews/create", "reviews/delete"]
 * ```
 */
export const entries = (nodes: Node.NodeRegistry, options?: Options): ReadonlyArray<Entry> =>
  [...nodes.nodes.values()].flatMap((node) => nodeEntries(node, options?.writes));

/** The graph-derived CRUD mutations as a registry of their own. Duplicate names cannot occur. */
export const registry = (nodes: Node.NodeRegistry, options?: Options): Mutator.MutatorRegistry =>
  Mutator.registry(entries(nodes, options));
