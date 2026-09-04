/**
 * DocumentWriter
 *
 * Rows to a JSON:API compound document — the **one serialiser** ADR-0029 §6
 * binds both the derived REST handlers ({@link RestHandlers}, #163) and the
 * service-worker façade (#164) to: "same URL, same result". The document is
 * a pure function of the node graph, the read, the resolved rows and the
 * `fields[]` projection — no HTTP, no backend, no clock — so the two sides
 * agree byte for byte on document content whichever source produced the
 * rows.
 *
 * The mapping, node for node (CONTEXT.md: a `type` is a collection, a
 * resource `id` is a row id, a resource is a row value):
 *
 * - **Attributes** are the node's declared attributes, in declaration order,
 *   read off the row value. A `one`-edge's key field (`categoryId`) is not
 *   an attribute: it is linkage.
 * - **Relationships** come from two places. A `one` edge's linkage is its
 *   `via` field on the row (`{ data: { type, id } }`, or `data: null` when
 *   the key is null). A collection-valued edge's linkage is the edge rows
 *   the read resolved onto the row (`related[edge]`): present when the read
 *   path fetched them, absent otherwise — a relationship never claims an
 *   empty list it did not see. A paginated edge always carries the spec's
 *   `links` (`self` / `related`, effect-jsonapi's model of an unbounded
 *   relationship) and, when the read resolved its rows (`include=reviews`
 *   includes a paginated edge like any other; only a per-edge window has no
 *   URL form), their linkage beside the links.
 * - **`included`** holds the rows of every edge the read `include`s, in
 *   code-point order of edge name then root-row order, deduplicated by
 *   `(type, id)` with full linkage checked (`Handlers.buildIncluded`). An
 *   included resource carries its own `one`-edge linkage and paginated
 *   links; its collection-valued edges are not resolved (ADR-0025's two
 *   phases stop at the included rows).
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
 * Only **node rows** are written (a row value carrying the node's attributes
 * and its `one`-edge key fields, as `Node.row` decodes). The `JsonApiRow`
 * shape of `Derive.ts` (linkage under `relationships`, no node graph) is not
 * a second strategy here: it has no registry to plan against, and nothing
 * serves it over REST yet.
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

/** What a document is a function of (ADR-0029 §6). */
export interface Input {
  readonly nodes: Node.NodeRegistry;
  /** The read as parsed from the URL — its `include` selects `included`, its plan is `links.self`. */
  readonly read: Query.Read;
  /**
   * The read's resolved rows (`Query.runVia` / `Query.run`): root rows in
   * window order, each with the edge rows resolved onto `related`. Edges
   * beyond `read.include` may be present (the REST tier resolves every
   * `many` edge for linkage); they contribute linkage, not `included`.
   */
  readonly rows: ReadonlyArray<Related.RelatedRow>;
  /** The `fields[]` projection, applied to attributes at the end. */
  readonly fields?: JsonApiQuery.Projection;
  /** Prepended to every link (the api's mount path, e.g. `/jsonapi`); default `""`. */
  readonly prefix?: string;
}

// ─── Rows → resource objects ─────────────────────────────────────────────────

/** A row value as a record (a node row always is one). */
const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The row id a related value carries (node rows carry `id` in the value). */
const idOf = (value: unknown): string => String(recordOf(value)["id"]);

/** The node's declared attributes off the row value, in declaration order; absent ones are left out. */
const attributesOf = (node: Node.AnyNode, value: Readonly<Record<string, unknown>>) => {
  const attributes: Record<string, unknown> = {};
  for (const field of Object.keys(node.attributes)) {
    if (value[field] !== undefined) attributes[field] = value[field];
  }
  return attributes;
};

/** The identifier list of resolved edge rows. */
const linkageOf = (type: string, rows: ReadonlyArray<unknown>): ReadonlyArray<Identifier> =>
  rows.map((row) => ({ type, id: idOf(row) }));

/** The relationship object of one edge, or `undefined` when nothing is known about it. */
const relationshipOf = (
  node: Node.AnyNode,
  id: string,
  name: string,
  value: Readonly<Record<string, unknown>>,
  related: Readonly<Record<string, Related.RelatedValue>> | undefined,
  prefix: string
): RelationshipValue | undefined => {
  const edge = node.edges[name]!;
  if (edge.kind === "one") {
    const key = value[edge.via];
    return {
      data: key === undefined || key === null ? null : { type: edge.target, id: String(key) },
    };
  }
  const rows = related?.[name];
  const data = Array.isArray(rows) ? { data: linkageOf(edge.target, rows) } : undefined;
  if (edge.kind === "many") return data;
  return {
    links: {
      self: `${prefix}${Handlers.relationshipLink(node.type, id, name)}`,
      related: `${prefix}${Handlers.relatedLink(node.type, id, name)}`,
    },
    ...data,
  };
};

/** The resource object of one row of a node. */
const resourceOf = (
  node: Node.AnyNode,
  row: {
    readonly id: string;
    readonly value: unknown;
    readonly related?: Related.RelatedRow["related"];
  },
  prefix: string
): ResourceValue => {
  const value = recordOf(row.value);
  const relationships: Record<string, RelationshipValue> = {};
  for (const name of Object.keys(node.edges)) {
    const relationship = relationshipOf(node, row.id, name, value, row.related, prefix);
    if (relationship !== undefined) relationships[name] = relationship;
  }
  return {
    type: node.type,
    id: row.id,
    attributes: attributesOf(node, value),
    ...(Object.keys(relationships).length === 0 ? {} : { relationships }),
  };
};

/** The edge rows of one included edge across the root rows, as resources of the target node. */
const includedOf = (
  nodes: Node.NodeRegistry,
  node: Node.AnyNode,
  rows: ReadonlyArray<Related.RelatedRow>,
  name: string,
  prefix: string
): ReadonlyArray<ResourceValue> => {
  const target = nodes.nodes.get(node.edges[name]!.target)!;
  const included: Array<ResourceValue> = [];
  for (const row of rows) {
    const value = row.related[name];
    const values = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    for (const related of values)
      included.push(resourceOf(target, { id: idOf(related), value: related }, prefix));
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
  const prefix = input.prefix ?? "";
  const data = input.rows.map((row) => project(resourceOf(node, row, prefix), input.fields));
  const included = Object.keys(input.read.include ?? {})
    .toSorted(Predicate.compareText)
    .flatMap((name) => includedOf(input.nodes, node, input.rows, name, prefix))
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
