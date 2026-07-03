/**
 * Node
 *
 * A typed resource (ADR-0022): scalar attributes plus {@link Edge}s to
 * other nodes. The Node definition is the single source of truth the rest
 * of the system derives from — its row schema (id + attributes + the
 * foreign-key fields its `one` edges declare), the {@link Collection} the
 * engine materializes, the joins and sync windows its edges imply, and the
 * fan-out **derivable set** (ADR-0023: `one`-edge keys + declared
 * `hintKeys`).
 *
 * Ids are branded per node type, so a `products` id cannot be passed where
 * a `categories` id is expected; `one`-edge fields carry the **target**
 * type's brand.
 *
 * Edges reference targets by name; {@link registry} closes the graph and
 * validates it (targets exist, inverses resolve to a matching `one` edge),
 * then derives the engine's `CollectionRegistry` — so the existing engine,
 * `Related` joins, and auth filters consume Node definitions unchanged
 * while later ADR-0022 program steps move onto them directly.
 */

import { Schema } from "effect";
import * as Collection from "./Collection.js";
import * as Edge from "./Edge.js";
import { DuplicateNameError, UnknownCollectionError } from "./Errors.js";
import * as Subset from "./Subset.js";

/** The branded id schema for a node type: `string & Brand<"<type>/id">`. */
export interface Id<Type extends string> extends Schema.brand<Schema.String, `${Type}/id`> {}

/** Create the branded id schema for a node type. */
export const Id = <const Type extends string>(type: Type): Id<Type> =>
  Schema.String.pipe(Schema.brand(`${type}/id` as `${Type}/id`));

/** The foreign-key fields a node's `one` edges add to its row schema. */
type ViaFields<Edges extends Record<string, Edge.Edge>> = {
  readonly [K in keyof Edges as Edges[K] extends Edge.One<string, infer Via>
    ? Via
    : never]: Edges[K] extends Edge.One<infer Target, string> ? Id<Target> : never;
};

/** A node definition. */
export interface Node<
  Type extends string = string,
  Fields extends Schema.Struct.Fields = Schema.Struct.Fields,
  Edges extends Record<string, Edge.Edge> = Record<string, Edge.Edge>,
> {
  readonly type: Type;
  readonly attributes: Fields;
  readonly edges: Edges;
  /**
   * Extra fields eligible for fine fan-out topics beyond the `one`-edge
   * keys (ADR-0023) — typically the auth-scoping key when it is not
   * already an edge.
   */
  readonly hintKeys: ReadonlyArray<string>;
  /** The branded id schema for this node type. */
  readonly Id: Id<Type>;
  /** The row schema: `{ id } & attributes & one-edge key fields`. */
  readonly row: Schema.Struct<{ readonly id: Id<Type> } & Fields & ViaFields<Edges>>;
}

/** A node definition with its type parameters erased. */
export type AnyNode = Node<string, Schema.Struct.Fields, Record<string, Edge.Edge>>;

/** The decoded row type of a node. */
export type RowOf<N extends AnyNode> = N["row"]["Type"];

/** Define a node type. */
export const make = <
  const Type extends string,
  const Fields extends Schema.Struct.Fields,
  const Edges extends Record<string, Edge.Edge> = {},
>(
  type: Type,
  options: {
    readonly attributes: Fields;
    readonly edges?: Edges;
    readonly hintKeys?: ReadonlyArray<string>;
  }
): Node<Type, Fields, Edges> => {
  const edges = options.edges ?? ({} as Edges);
  const id = Id(type);
  const viaFields: Record<string, Schema.Top> = {};
  for (const edge of Object.values(edges)) {
    if (edge.kind === "one") viaFields[edge.via] = Id(edge.target);
  }
  const row = Schema.Struct({
    id,
    ...options.attributes,
    ...viaFields,
  }) as unknown as Node<Type, Fields, Edges>["row"];
  return {
    type,
    attributes: options.attributes,
    edges,
    hintKeys: options.hintKeys ?? [],
    Id: id,
    row,
  };
};

/**
 * The fields of a node eligible for fine fan-out topics (ADR-0023): its
 * `one`-edge keys plus declared `hintKeys`. Declared on the node, so
 * topic registration and write-derivation cannot disagree.
 */
export const derivableSet = (node: AnyNode): ReadonlySet<string> => {
  const fields = new Set<string>(node.hintKeys);
  for (const edge of Object.values(node.edges)) {
    if (edge.kind === "one") fields.add(edge.via);
  }
  return fields;
};

/** A closed, validated node graph plus the engine registry derived from it. */
export interface NodeRegistry {
  readonly nodes: ReadonlyMap<string, AnyNode>;
  /** The engine's collection registry, derived edge-for-edge. */
  readonly collections: Collection.CollectionRegistry;
}

/** Resolve a collection-valued edge's key field from its inverse. */
const inverseVia = (
  node: AnyNode,
  name: string,
  edge: Edge.Many | Edge.Paginated,
  nodes: ReadonlyMap<string, AnyNode>
): string => {
  const target = nodes.get(edge.target);
  if (target === undefined) {
    throw new UnknownCollectionError({
      from: node.type,
      relationship: name,
      collection: edge.target,
    });
  }
  const inverse = target.edges[edge.inverse];
  if (inverse === undefined || inverse.kind !== "one" || inverse.target !== node.type) {
    throw new UnknownCollectionError({
      from: node.type,
      relationship: `${name} (inverse "${edge.inverse}" is not a one-edge back to ${node.type})`,
      collection: edge.target,
    });
  }
  return inverse.via;
};

/** Derive the engine collection for one node (registry context required). */
const toCollection = (
  node: AnyNode,
  nodes: ReadonlyMap<string, AnyNode>
): Collection.AnyCollection => {
  const relationships: Array<Collection.Relationship> = [];
  for (const [name, edge] of Object.entries(node.edges)) {
    if (edge.kind === "one") {
      relationships.push({
        name,
        kind: "one",
        collection: edge.target,
        localField: edge.via,
        foreignField: "id",
      });
    } else {
      relationships.push({
        name,
        kind: edge.kind,
        collection: edge.target,
        localField: "id",
        foreignField: inverseVia(node, name, edge, nodes),
        ...(edge.kind === "paginated" ? { order: Subset.parseOrder(edge.order) } : {}),
      });
    }
  }
  return Collection.make({
    name: node.type,
    schema: node.row as unknown as Schema.Codec<unknown, unknown>,
    id: (value) => (value as { id: string }).id,
    relationships,
  });
};

/**
 * Close and validate the node graph: unique types, every edge target
 * present, every collection-valued edge's `inverse` resolving to a `one`
 * edge back to the declaring node. Returns the graph plus the derived
 * engine `CollectionRegistry`.
 */
export const registry = (definitions: ReadonlyArray<AnyNode>): NodeRegistry => {
  const nodes = new Map<string, AnyNode>();
  for (const node of definitions) {
    if (nodes.has(node.type)) throw new DuplicateNameError({ kind: "collection", name: node.type });
    nodes.set(node.type, node);
  }
  for (const node of definitions) {
    for (const [name, edge] of Object.entries(node.edges)) {
      if (!nodes.has(edge.target)) {
        throw new UnknownCollectionError({
          from: node.type,
          relationship: name,
          collection: edge.target,
        });
      }
      if (edge.kind !== "one") inverseVia(node, name, edge, nodes);
    }
  }
  const collections = Collection.registry(definitions.map((node) => toCollection(node, nodes)));
  return { nodes, collections };
};
