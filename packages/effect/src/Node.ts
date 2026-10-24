/**
 * Node
 *
 * A typed resource (ADR-0022): scalar attributes plus {@link Edge}s to
 * other nodes. The Node definition is the single source of truth the rest
 * of the system derives from — its row schema (the identity attribute + its
 * attributes + the foreign-key fields its `one` edges declare), the
 * {@link Collection} the engine materializes, the joins and sync windows its
 * edges imply, and the fan-out **derivable set** (ADR-0023: `one`-edge keys
 * + declared `hintKeys`), and the **filterable set** (ADR-0028, #154: the
 * fields a client may filter or sort by, with their operators and kinds).
 *
 * Ids are branded per node type, so a `products` id cannot be passed where
 * a `categories` id is expected; `one`-edge fields carry the **target**
 * type's brand.
 *
 * A node's **identity attribute** is the attribute supplying its row id. It
 * defaults to a synthetic branded `id` added to the row, and a domain with
 * natural keys names one of its own attributes instead (`id: "username"`) —
 * so the key is stored once, not duplicated into an `id` nothing keeps equal
 * to it. Everything downstream reads the declared name: the derived
 * collection's id extractor, both ends of every edge's join (each resolved
 * from its own node, so the two ends may differ), and the filterable set a
 * client's `where` / `order` is admitted against. Row ids are strings on the
 * wire and in CVR bookkeeping either way (ADR-0008) — this names which
 * attribute supplies the string, nothing more.
 *
 * Edges reference targets by name; {@link registry} closes the graph and
 * validates it (targets exist, inverses resolve to a matching `one` edge),
 * then derives the engine's `CollectionRegistry` — so the existing engine,
 * `Related` joins, and auth filters consume Node definitions unchanged
 * while later ADR-0022 program steps move onto them directly.
 */

import * as Arr from "effect/Array";
import type * as Brand from "effect/Brand";
import * as Schema from "effect/Schema";
import * as Collection from "./Collection.js";
import * as Edge from "./Edge.js";
import { DuplicateNameError, FilterDeclarationError, UnknownCollectionError } from "./Errors.js";
import * as FilterPolicy from "./FilterPolicy.js";
import * as Subset from "./Subset.js";

/** The branded id schema for a node type: `string & Brand<"<type>/id">`. */
export interface Id<Type extends string> extends Schema.brand<Schema.String, `${Type}/id`> {}

/** Create the branded id schema for a node type. */
export const Id = <const Type extends string>(type: Type): Id<Type> =>
  // SAFETY: effect 4.0.0 types `Schema.brand`'s parameter as
  // `B & EnsureSingleBrandKey<B>`, which TypeScript cannot resolve while `Type`
  // is generic. The guard only checks that the identifier is one concrete
  // (non-union, non-wide) string and is `unknown` for the literal ids callers
  // pass; the cast only satisfies it, the value is the same template string,
  // and the public `Id<Type>` signature is untouched.
  Schema.String.pipe(
    Schema.brand<`${Type}/id`>(`${type}/id` as Parameters<typeof Schema.brand<`${Type}/id`>>[0])
  );

/** The foreign-key fields a node's `one` edges add to its row schema. */
type ViaFields<Edges extends Record<string, Edge.Edge>> = {
  readonly [
    K in keyof Edges as Edges[K] extends Edge.One<string, infer Via> ? Via : never
  ]: Edges[K] extends Edge.One<infer Target, string> ? Id<Target> : never;
};

/**
 * The field names of a node's row: its identity attribute — the synthetic
 * `id` unless the definition names one of its own attributes — plus its
 * attributes and its `one`-edge keys.
 */
export type FieldName<
  Fields extends Schema.Struct.Fields,
  Edges extends Record<string, Edge.Edge>,
  IdField extends string | undefined = undefined,
> =
  | (IdField extends string ? never : "id")
  | (keyof Fields & string)
  | (keyof ViaFields<Edges> & string);

/**
 * The row schema of a node: a synthetic branded `id` plus the attributes and
 * `one`-edge keys, or — when the definition names an attribute as its
 * identity — the attributes and `one`-edge keys alone, the identity among
 * them.
 */
export type Row<
  Type extends string,
  Fields extends Schema.Struct.Fields,
  Edges extends Record<string, Edge.Edge>,
  IdField extends string | undefined = undefined,
> = IdField extends string
  ? Schema.Struct<Fields & ViaFields<Edges>>
  : Schema.Struct<{ readonly id: Id<Type> } & Fields & ViaFields<Edges>>;

/** A node definition. */
export interface Node<
  Type extends string = string,
  Fields extends Schema.Struct.Fields = Schema.Struct.Fields,
  Edges extends Record<string, Edge.Edge> = Record<string, Edge.Edge>,
  IdField extends string | undefined = string | undefined,
> {
  readonly type: Type;
  /**
   * The attribute supplying the row id: the declared one (`make`'s `id`
   * option), or `"id"` — the synthetic branded attribute added to the row
   * when a node names none. Every place the graph joins, filters, sorts or
   * keys by identity reads this name, never the literal `"id"`.
   */
  readonly id: IdField extends string ? IdField : "id";
  readonly attributes: Fields;
  readonly edges: Edges;
  /**
   * Extra fields eligible for fine fan-out topics beyond the `one`-edge
   * keys (ADR-0023) — typically the auth-scoping key when it is not
   * already an edge.
   */
  readonly hintKeys: ReadonlyArray<string>;
  /**
   * Fields eligible for secondary indexing (issue #113), carried through to
   * the derived {@link Collection}'s `indexes`. See
   * {@link Collection.Collection.indexes}.
   */
  readonly indexes: ReadonlyArray<string>;
  /**
   * The **filterable set** (ADR-0028 rule d, #154): every field a client may
   * filter by, with its operators and literal kind. The identity attribute
   * and every `one`-edge `via` field are filterable by `eq` / `in` (kind
   * `text`) by default; everything else is declared via `make`'s
   * `filterable` option. Carried to the derived {@link Collection} and
   * enforced by `Authorization.authorize` before evaluation.
   */
  readonly filterable: Readonly<Record<string, FilterPolicy.FilterableField>>;
  /**
   * The fields a client may order by (#154); always includes the identity
   * attribute (ADR-0026's tie-break).
   */
  readonly sortable: ReadonlyArray<string>;
  /** The branded id schema for this node type. */
  readonly Id: Id<Type>;
  /**
   * The row schema: `attributes & one-edge key fields`, with a branded `id`
   * added in front unless an attribute is declared as the identity.
   */
  readonly row: Row<Type, Fields, Edges, IdField>;
}

/**
 * A node definition with its type parameters erased.
 *
 * `Id` is bounded rather than erased to `Id<string>`: in Effect 4.0.0 brands
 * are type-only, so a concrete `brand<String, "todos/id">` no longer assigns
 * to a template-literal brand. The bound keeps it a string-encoded branded id
 * schema, whose decoded type is `string & Brand<string>`.
 */
export type AnyNode = Omit<Node<string, Schema.Struct.Fields, Record<string, Edge.Edge>>, "Id"> & {
  readonly Id: Schema.Codec<string & Brand.Brand<string>, string>;
};

/** The decoded row type of a node. */
export type RowOf<N extends AnyNode> = N["row"]["Type"];

/** Define a node type. */
export const make = <
  const Type extends string,
  const Fields extends Schema.Struct.Fields,
  // oxlint-disable-next-line effect/avoid-object-type -- public type parameter default of exported `Node.make`; `Record<string, never>` would change `keyof Edges` from `never` to `string` for nodes declared without edges.
  const Edges extends Record<string, Edge.Edge> = {},
  const IdField extends (keyof Fields & string) | undefined = undefined,
>(
  type: Type,
  options: {
    /**
     * The attribute supplying the row id — a **natural key**
     * (`id: "username"`), which must be one of this node's own string
     * attributes. Omitted, the row gets a synthetic branded `id` attribute
     * and everything behaves exactly as it did before a node could name its
     * identity, so a domain with surrogate keys declares nothing.
     *
     * Row ids stay strings on the wire and in CVR bookkeeping either way
     * (ADR-0008); this only names which attribute supplies the string.
     */
    readonly id?: IdField;
    readonly attributes: Fields;
    readonly edges?: Edges;
    readonly hintKeys?: ReadonlyArray<string>;
    readonly indexes?: ReadonlyArray<string>;
    /**
     * The fields a client may filter by, beyond the identity / `one`-edge key
     * defaults: the operators alone (the literal kind is derived from the
     * attribute's schema — `FilterPolicy.kindOf`), or `{ operators, kind }`
     * where derivation cannot tell (an `instant` stored as text). A key
     * field may be listed to widen its default operators.
     */
    readonly filterable?: {
      readonly [K in FieldName<Fields, Edges, IdField>]?: FilterPolicy.FilterableInput;
    };
    /** The fields a client may order by, beyond the identity attribute. */
    readonly sortable?: ReadonlyArray<FieldName<Fields, Edges, IdField>>;
  }
): Node<Type, Fields, Edges, IdField> => {
  const edges = options.edges ?? ({} as Edges);
  const id = Id(type);
  const identity = options.id ?? "id";
  if (options.id !== undefined) assertTextIdentity(type, options.id, options.attributes);
  const viaFields: Record<string, Schema.Top> = {};
  Arr.forEach(Object.values(edges), (edge) => {
    if (edge.kind === "one") viaFields[edge.via] = Id(edge.target);
  });
  const declaration = FilterPolicy.resolve({
    collection: type,
    attributes: options.attributes,
    identity,
    keyFields: [identity, ...Object.keys(viaFields)],
    filterable: options.filterable as Readonly<Record<string, FilterPolicy.FilterableInput>>,
    sortable: options.sortable,
  });
  const row = Schema.Struct({
    // A declared identity is already one of the attributes; only a node
    // without one gets the synthetic branded `id`.
    ...(options.id === undefined ? { id } : {}),
    ...options.attributes,
    ...viaFields,
  }) as Node<Type, Fields, Edges, IdField>["row"];
  return {
    type,
    id: identity as Node<Type, Fields, Edges, IdField>["id"],
    attributes: options.attributes,
    edges,
    hintKeys: options.hintKeys ?? [],
    indexes: options.indexes ?? [],
    filterable: declaration.filterable,
    sortable: declaration.sortable,
    Id: id,
    row,
  };
};

/**
 * A declared identity attribute must carry the row id, and a row id is a
 * string on the wire (ADR-0008) — so an attribute whose literal kind is
 * derivably something else is a definition defect, not a runtime surprise at
 * the filter boundary. A kind that cannot be derived at all passes: the
 * declaration is taken at its word, exactly as `filterable` does.
 */
const assertTextIdentity = (
  type: string,
  identity: string,
  attributes: Schema.Struct.Fields
): void => {
  const attribute = attributes[identity];
  const kind = attribute === undefined ? undefined : FilterPolicy.kindOf(attribute);
  if (kind === undefined || kind === "text") return;
  throw new FilterDeclarationError({
    collection: type,
    field: identity,
    message: `Node "${type}" declares "${identity}" as its identity attribute, but its literal kind is "${kind}"; a row id is a string`,
  });
};

/**
 * The fields of a node eligible for fine fan-out topics (ADR-0023): its
 * `one`-edge keys plus declared `hintKeys`. Declared on the node, so
 * topic registration and write-derivation cannot disagree.
 */
export const derivableSet = (node: AnyNode): ReadonlySet<string> => {
  const fields = new Set<string>(node.hintKeys);
  Arr.forEach(Object.values(node.edges), (edge) => {
    if (edge.kind === "one") fields.add(edge.via);
  });
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

/**
 * The identity attribute of an edge's target — resolved per-node, because
 * the two ends of one edge may name different identities (`comments.author →
 * users.username` while `comments.article → articles.slug`).
 */
const identityOf = (
  node: AnyNode,
  name: string,
  target: string,
  nodes: ReadonlyMap<string, AnyNode>
): string => {
  const resolved = nodes.get(target);
  if (resolved === undefined) {
    throw new UnknownCollectionError({ from: node.type, relationship: name, collection: target });
  }
  return resolved.id;
};

/** Derive the engine collection for one node (registry context required). */
const toCollection = (
  node: AnyNode,
  nodes: ReadonlyMap<string, AnyNode>
): Collection.AnyCollection => {
  const relationships: Array<Collection.Relationship> = [];
  Arr.forEach(Object.entries(node.edges), ([name, edge]) => {
    if (edge.kind === "one") {
      relationships.push({
        name,
        kind: "one",
        collection: edge.target,
        localField: edge.via,
        // The join matches the TARGET's identity attribute.
        foreignField: identityOf(node, name, edge.target, nodes),
      });
    } else {
      relationships.push({
        name,
        kind: edge.kind,
        collection: edge.target,
        // The parent side of a dependent collection is this node's identity.
        localField: node.id,
        foreignField: inverseVia(node, name, edge, nodes),
        ...(edge.kind === "paginated" ? { order: Subset.parseOrder(edge.order) } : {}),
      });
    }
  });
  return Collection.make({
    name: node.type,
    // oxlint-disable-next-line effect/avoid-any, effect/no-chained-type-assertions -- `AnyNode` erases fields to the open `Schema.Struct.Fields`, whose services are `unknown`; `Collection.make` needs a service-free codec, which node rows are by construction but the exported types cannot state.
    schema: node.row as unknown as Schema.Codec<unknown, unknown>,
    id: (value) => (value as Record<string, string>)[node.id] ?? "",
    identity: node.id,
    relationships,
    ...(Arr.isReadonlyArrayNonEmpty(node.indexes) ? { indexes: node.indexes } : {}),
    // The filterable set travels like `indexes` (#154): the server enforces
    // it from the collection alone.
    filterable: node.filterable,
    sortable: node.sortable,
  });
};

/**
 * Every field of a node's row: its identity attribute, its attributes, its
 * `one`-edge keys. A declared identity is one of the attributes already; an
 * undeclared one is the synthetic `id`.
 */
const rowFields = (node: AnyNode): ReadonlySet<string> => {
  const fields = new Set<string>([node.id, ...Object.keys(node.attributes)]);
  Arr.forEach(Object.values(node.edges), (edge) => {
    if (edge.kind === "one") fields.add(edge.via);
  });
  return fields;
};

/**
 * A paginated edge's declared `order` is what its per-parent windows sort
 * the **target** by (ADR-0024), so those fields join the target's
 * `sortable` here — declared on the node graph, so window registration and
 * the filterable set cannot disagree (as `one`-edge keys are `eq` / `in`).
 * An order field the target's row does not carry is a definition defect.
 */
const withEdgeOrders = (node: AnyNode, definitions: ReadonlyArray<AnyNode>): AnyNode => {
  const sortable = new Set<string>(node.sortable);
  const fields = rowFields(node);
  Arr.forEach(definitions, (source) =>
    Arr.forEach(Object.entries(source.edges), ([name, edge]) => {
      if (edge.kind !== "paginated" || edge.target !== node.type) return;
      Arr.forEach(Subset.parseOrder(edge.order), (term) => {
        if (!fields.has(term.field)) {
          throw new FilterDeclarationError({
            collection: node.type,
            field: term.field,
            message: `Paginated edge "${name}" on ${source.type} orders "${node.type}" by "${term.field}", which is not a field of its row`,
          });
        }
        sortable.add(term.field);
      });
    })
  );
  return sortable.size === node.sortable.length ? node : { ...node, sortable: [...sortable] };
};

/**
 * Close and validate the node graph: unique types, every edge target
 * present, every collection-valued edge's `inverse` resolving to a `one`
 * edge back to the declaring node, every paginated edge's order over fields
 * its target carries. Returns the graph — each node's `sortable` widened by
 * the paginated edges ordering it — plus the derived engine
 * `CollectionRegistry`.
 */
export const registry = (definitions: ReadonlyArray<AnyNode>): NodeRegistry => {
  const declared = new Map<string, AnyNode>();
  Arr.forEach(definitions, (node) => {
    if (declared.has(node.type)) {
      throw new DuplicateNameError({ kind: "collection", name: node.type });
    }
    declared.set(node.type, node);
  });
  Arr.forEach(definitions, (node) => {
    Arr.forEach(Object.entries(node.edges), ([name, edge]) => {
      if (!declared.has(edge.target)) {
        throw new UnknownCollectionError({
          from: node.type,
          relationship: name,
          collection: edge.target,
        });
      }
      if (edge.kind !== "one") inverseVia(node, name, edge, declared);
    });
  });
  const nodes = new Map<string, AnyNode>();
  Arr.forEach(definitions, (node) => {
    nodes.set(node.type, withEdgeOrders(node, definitions));
  });
  const collections = Collection.registry(
    [...nodes.values()].map((node) => toCollection(node, nodes))
  );
  return { nodes, collections };
};
