/**
 * DocumentWriter
 *
 * Rows to a JSON:API compound document — the **one serialiser** ADR-0029 §6
 * binds both the derived REST handlers ({@link RestHandlers}, #163) and the
 * replica-side writer behind the service-worker façade
 * ({@link ReplicaDocuments}, #164) to: "same URL, same result". The
 * document is a pure function of the node graph, the read, the resolved
 * rows and the `fields[]` projection — no HTTP, no backend, no clock — so
 * the two sides agree byte for byte on document content whichever source
 * produced the rows.
 *
 * The mapping, node for node (CONTEXT.md: a `type` is a collection, a
 * resource `id` is a row id, a resource is a row value):
 *
 * - **Attributes** are the node's declared attributes, in declaration order,
 *   read off the row value. A `one`-edge's key field (`categoryId`) is not
 *   an attribute: it is linkage.
 * - **Relationships** come from two places. A `one` edge's linkage is its
 *   key on the row (`{ data: { type, id } }`, or `data: null` when the key
 *   is null). A collection-valued edge's linkage is the edge rows the read
 *   resolved onto the row (`related[edge]`): present when the read path
 *   fetched them, absent otherwise — a relationship never claims an empty
 *   list it did not see. A paginated edge always carries the spec's `links`
 *   (`self` / `related`, effect-jsonapi's model of an unbounded
 *   relationship) and, when the read resolved its rows (`include=reviews`
 *   includes a paginated edge like any other; only a per-edge window has no
 *   URL form), their linkage beside the links.
 * - **`included`** holds the rows of every edge the read `include`s, in
 *   code-point order of edge name then root-row order, deduplicated by
 *   `(type, id)` with full linkage checked (`Handlers.buildIncluded`: an
 *   included row no resource identifier in the document references is
 *   thrown at, never emitted). An included resource carries its own
 *   `one`-edge linkage and paginated links, and the collection-valued
 *   linkage the caller resolved for it ({@link Input.linkage} — the third
 *   batch, keyed by the included rows); an edge with no resolved rows is
 *   omitted.
 * - **`fields[type]`** is applied last, to attributes only, on primary and
 *   included resources alike (ADR-0029 §5: a serialisation-time projection
 *   over full rows). Linkage is never projected away.
 * - **`links.self`** is the read's canonical string (`JsonApiQuery.canonical`)
 *   — one string per plan, whatever the request's spelling — and a
 *   collection whose window is full (`first` rows came back) carries
 *   `links.next`: the same canonical query with `page[after]` at the last
 *   row's id, the cursor `Subset.apply` continues from. A short page has no
 *   `next`. An optional `prefix` (the api's mount path) is prepended to
 *   every link; ADR-0029 §6 lets the host differ, nothing else.
 *
 * **Row shapes.** Where a row keeps its linkage is the one thing the
 * engine's two row shapes disagree on, and a {@link RowShape} names it. A
 * **node row** (the default, {@link nodeRows} — what `Node.row` decodes and
 * `Query.run` resolves) carries a `one` edge's key in its `via` field and
 * no collection-valued linkage of its own. A **`JsonApiRow`**
 * ({@link jsonApiRows} — `Derive.ts`'s shape, attributes flattened plus the
 * server's `relationships` linkage) carries every relationship's
 * identifiers under `relationships[name]`, so a `many` edge the read did
 * not resolve still links through the identifiers the row holds. Both
 * shapes flatten attributes at the top level, so attributes need no
 * strategy. The graph is still the node graph: a `JsonApiRow` collection
 * is written against the registry that declares its type (`NodeBridge`
 * over the app's resources); `Derive.ts`'s own collections declare no
 * graph and cannot be written until one does.
 */

import { Handlers } from "@thomasfosterau/effect-jsonapi";
import { type Node, Predicate, type Query } from "@legation/effect";
import type { Related } from "@legation/effect/internal";
import * as JsonApiQuery from "./JsonApiQuery.js";

/** A resource identifier: `{ type, id }`. */
export interface Identifier {
  readonly type: string;
  readonly id: string;
}

/**
 * A relationship object as written: inline linkage for `one` / `many`
 * edges; links for a paginated edge, with its rows' linkage when resolved.
 */
export type RelationshipValue =
  | { readonly data: Identifier | ReadonlyArray<Identifier> | null }
  | {
      readonly links: { readonly self: string; readonly related: string };
      readonly data?: ReadonlyArray<Identifier>;
    };

/** A resource object as written: the node's attributes and its edges' relationships. */
export interface ResourceValue {
  readonly type: string;
  readonly id: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly relationships?: Readonly<Record<string, RelationshipValue>>;
}

/** A collection document: `{ data: [...], included?, links }`. */
export type CollectionDocument = Handlers.DocumentValue<
  ReadonlyArray<ResourceValue>,
  ResourceValue
>;

/** A single-resource document: `{ data: resource | null, included?, links }`. */
export type DataDocument = Handlers.DocumentValue<ResourceValue | null, ResourceValue>;

/** Edge rows by collection, then row id, then edge name (see {@link Input.linkage}). */
export type Linkage = ReadonlyMap<
  string,
  ReadonlyMap<string, Readonly<Record<string, ReadonlyArray<unknown>>>>
>;

/** A row value as a record (a row value always is one). */
export type RowValue = Readonly<Record<string, unknown>>;

/**
 * Where a row value keeps its linkage (see the module doc): the key a
 * `one` edge links through, and the identifiers a collection-valued edge
 * carries on the row itself when its rows were not resolved.
 */
export interface RowShape {
  /** The target id a `one` edge links to on this row; `null` or `undefined` for none. */
  readonly oneKey: (value: RowValue, name: string, via: string) => unknown;
  /**
   * The target ids of a collection-valued edge the row itself carries, or
   * `undefined` when the row carries none (the edge is then omitted unless
   * the read resolved its rows). Absent for a shape whose rows carry no
   * such linkage.
   */
  readonly manyIds?: (value: RowValue, name: string) => ReadonlyArray<string> | undefined;
}

/** Node rows: a `one` edge's key is its `via` field; collection-valued linkage comes from resolved rows alone. */
export const nodeRows: RowShape = {
  oneKey: (value, _name, via) => value[via],
};

/** A `JsonApiRow`'s linkage for one relationship: an identifier, a list of them, or `null`. */
type RowLinkage = Identifier | ReadonlyArray<Identifier> | null | undefined;

/** The `relationships` member of a `JsonApiRow`, by relationship name. */
const rowLinkageOf = (value: RowValue, name: string): RowLinkage =>
  (value["relationships"] as Readonly<Record<string, RowLinkage>> | undefined)?.[name];

const isIdentifierList = (linkage: RowLinkage): linkage is ReadonlyArray<Identifier> =>
  Array.isArray(linkage);

/** `JsonApiRow`s: every edge's linkage is the identifier(s) under `relationships[name]`. */
export const jsonApiRows: RowShape = {
  oneKey: (value, name) => {
    const linkage = rowLinkageOf(value, name);
    return linkage === undefined || linkage === null || isIdentifierList(linkage)
      ? null
      : linkage.id;
  },
  manyIds: (value, name) => {
    const linkage = rowLinkageOf(value, name);
    return isIdentifierList(linkage) ? linkage.map((identifier) => identifier.id) : undefined;
  },
};

/** What a document is a function of (ADR-0029 §6). */
export interface Input {
  readonly nodes: Node.NodeRegistry;
  /** The read as parsed from the URL — its `include` selects `included`, its plan is `links.self`. */
  readonly read: Query.Read;
  /**
   * The read's resolved rows (`Query.runVia` / `Query.run`): root rows in
   * window order, each with the edge rows resolved onto `related`. Edges
   * beyond `read.include` may be present (the linkage plan resolves every
   * declared `many` edge); they contribute linkage, not `included`.
   */
  readonly rows: ReadonlyArray<Related.RelatedRow>;
  /**
   * Collection-valued edge rows resolved for resources beyond the root rows
   * — the included resources' own `many` edges — by collection, then row
   * id, then edge name. Consulted where a row has no `related` entry for
   * the edge; a parent listed with an empty array gets `data: []`.
   */
  readonly linkage?: Linkage;
  /** The `fields[]` projection, applied to attributes at the end. */
  readonly fields?: JsonApiQuery.Projection;
  /** Prepended to every link (the api's mount path, e.g. `/jsonapi`); default `""`. */
  readonly prefix?: string;
  /** How the rows carry their linkage; default {@link nodeRows}. */
  readonly shape?: RowShape;
}

// ─── Rows → resource objects ─────────────────────────────────────────────────

/** The per-document constants every row is written under. */
interface Env {
  readonly nodes: Node.NodeRegistry;
  readonly linkage: Linkage | undefined;
  readonly prefix: string;
  readonly shape: RowShape;
}

const envOf = (input: Input): Env => ({
  nodes: input.nodes,
  linkage: input.linkage,
  prefix: input.prefix ?? "",
  shape: input.shape ?? nodeRows,
});

/** A row value as a record (a row value always is one). */
const recordOf = (value: unknown): RowValue =>
  typeof value === "object" && value !== null ? (value as RowValue) : {};

/** The row id a related value carries (rows carry `id` in the value). */
const idOf = (value: unknown): string => String(recordOf(value)["id"]);

/** The node's declared attributes off the row value, in declaration order; absent ones are left out. */
const attributesOf = (node: Node.AnyNode, value: RowValue) => {
  const attributes: Record<string, unknown> = {};
  for (const field of Object.keys(node.attributes)) {
    if (value[field] !== undefined) attributes[field] = value[field];
  }
  return attributes;
};

/** A row as the writer sees it: its id and value, the root rows' `related`, and everything else's linkage. */
interface Row {
  readonly id: string;
  readonly value: unknown;
  readonly related?: Related.RelatedRow["related"];
}

/** The resolved rows of one collection-valued edge of a row: `related` first, then the caller's linkage. */
const edgeRowsOf = (
  env: Env,
  node: Node.AnyNode,
  row: Row,
  name: string
): ReadonlyArray<unknown> | undefined => {
  const related = row.related?.[name];
  return Array.isArray(related) ? related : env.linkage?.get(node.type)?.get(row.id)?.[name];
};

/** The identifiers a collection-valued edge links to: the resolved rows', else those the row itself carries. */
const identifiersOf = (
  env: Env,
  node: Node.AnyNode,
  row: Row,
  name: string,
  target: string
): ReadonlyArray<Identifier> | undefined => {
  const rows = edgeRowsOf(env, node, row, name);
  const ids = rows === undefined ? env.shape.manyIds?.(recordOf(row.value), name) : rows.map(idOf);
  return ids?.map((id) => ({ type: target, id }));
};

/** The relationship object of one edge, or `undefined` when nothing is known about it. */
const relationshipOf = (
  env: Env,
  node: Node.AnyNode,
  row: Row,
  name: string
): RelationshipValue | undefined => {
  const edge = node.edges[name]!;
  if (edge.kind === "one") {
    const key = env.shape.oneKey(recordOf(row.value), name, edge.via);
    return {
      data: key === undefined || key === null ? null : { type: edge.target, id: String(key) },
    };
  }
  const identifiers = identifiersOf(env, node, row, name, edge.target);
  const data = identifiers === undefined ? undefined : { data: identifiers };
  if (edge.kind === "many") return data;
  return {
    links: {
      self: `${env.prefix}${Handlers.relationshipLink(node.type, row.id, name)}`,
      related: `${env.prefix}${Handlers.relatedLink(node.type, row.id, name)}`,
    },
    ...data,
  };
};

/** The resource object of one row of a node. */
const resourceOf = (env: Env, node: Node.AnyNode, row: Row): ResourceValue => {
  const relationships: Record<string, RelationshipValue> = {};
  for (const name of Object.keys(node.edges)) {
    const relationship = relationshipOf(env, node, row, name);
    if (relationship !== undefined) relationships[name] = relationship;
  }
  return {
    type: node.type,
    id: row.id,
    attributes: attributesOf(node, recordOf(row.value)),
    ...(Object.keys(relationships).length === 0 ? {} : { relationships }),
  };
};

/** The edge rows of one included edge across the root rows, as resources of the target node. */
const includedOf = (
  env: Env,
  node: Node.AnyNode,
  rows: ReadonlyArray<Related.RelatedRow>,
  name: string
): ReadonlyArray<ResourceValue> => {
  const target = env.nodes.nodes.get(node.edges[name]!.target)!;
  const included: Array<ResourceValue> = [];
  for (const row of rows) {
    const value = row.related[name];
    const values = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    for (const related of values) {
      included.push(resourceOf(env, target, { id: idOf(related), value: related }));
    }
  }
  return included;
};

/** The resource's attributes narrowed to its type's `fields[]` entry, when one is given. */
const project = (
  resource: ResourceValue,
  fields: JsonApiQuery.Projection | undefined
): ResourceValue => {
  const names = fields?.[resource.type];
  if (names === undefined) return resource;
  const attributes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(resource.attributes)) {
    if (names.includes(field)) attributes[field] = value;
  }
  return { ...resource, attributes };
};

// ─── Documents ───────────────────────────────────────────────────────────────

/** The node a read addresses; a read on an unknown collection is a definition defect. */
const nodeOf = (nodes: Node.NodeRegistry, read: Query.Read): Node.AnyNode => {
  const node = nodes.nodes.get(read.collection);
  if (node === undefined)
    throw new Error(`DocumentWriter: unknown collection "${read.collection}"`);
  return node;
};

/** The primary resources and the compound `included`, both projected. */
const assemble = (input: Input, node: Node.AnyNode) => {
  const env = envOf(input);
  const data = input.rows.map((row) => project(resourceOf(env, node, row), input.fields));
  const included = Object.keys(input.read.include ?? {})
    .toSorted(Predicate.compareText)
    .flatMap((name) => includedOf(env, node, input.rows, name))
    .map((resource) => project(resource, input.fields));
  return { data, included };
};

/** `links.self`: the read's canonical string behind the prefix. */
const selfLink = (input: Input): string =>
  `${input.prefix ?? ""}${JsonApiQuery.canonical(input.nodes, input.read, input.fields)}`;

/**
 * `links.next` for a full window: the canonical query continued after the
 * last row (`page[after]`), the cursor `Subset.apply` resumes from. A short
 * page — fewer rows than `first`, or no window at all — has no next.
 */
const nextLink = (input: Input): string | undefined => {
  const last = input.rows.at(-1);
  if (
    input.read.first === undefined ||
    last === undefined ||
    input.rows.length < input.read.first
  ) {
    return undefined;
  }
  return `${input.prefix ?? ""}${JsonApiQuery.canonical(input.nodes, { ...input.read, after: last.id }, input.fields)}`;
};

/**
 * The collection document of a read: every row as primary data, the
 * included edges compounded, `links.self` canonical and `links.next` when
 * the window is full. Throws for a read the canonical encoder refuses (a
 * per-edge window, an `Exists`) — such a read has no URL, so it is never
 * one a URL produced.
 */
export const collection = (input: Input): CollectionDocument => {
  const { data, included } = assemble(input, nodeOf(input.nodes, input.read));
  const next = nextLink(input);
  return Handlers.collection(data, {
    included,
    links: { self: selfLink(input), ...(next === undefined ? {} : { next }) },
  });
};

/**
 * The single-resource document of a read: the first row as primary data
 * (`null` when the read matched nothing — the caller decides the 404), the
 * included edges compounded, `links.self` canonical.
 */
export const data = (input: Input): DataDocument => {
  const first = input.rows[0];
  const { data: primary, included } = assemble(
    { ...input, rows: first === undefined ? [] : [first] },
    nodeOf(input.nodes, input.read)
  );
  return Handlers.data(primary[0] ?? null, { included, links: { self: selfLink(input) } });
};
