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
 *   omitted. The member itself is present exactly when the read has an
 *   `include`, as an empty array when nothing resolved (JSON:API 1.1
 *   §Fetching Includes: a response to a request carrying `include` is a
 *   compound document).
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
 * and its `one`-edge key fields, as `Node.row` decodes and `Query.run`
 * resolves). The `JsonApiRow` shape of `Derive.ts` (linkage under
 * `relationships`, no node graph) is not a second strategy here: its
 * collections declare no graph to plan against, so nothing can write them
 * until a bridge (`NodeBridge` over the app's resources) gives them one —
 * the seam is {@link relationshipOf}, the one place a row's linkage is read.
 */

import { Handlers } from "@thomasfosterau/effect-jsonapi";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import { type Node, Predicate, type Query } from "@thomasfosterau/legation-effect";
import type { Related } from "@thomasfosterau/legation-effect/internal";
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

/** A collection document: `{ data: [...], included?, links }`, with `included` exactly when the read has an `include`. */
export type CollectionDocument = Handlers.DocumentValue<
  ReadonlyArray<ResourceValue>,
  ResourceValue
>;

/** A single-resource document: `{ data: resource | null, included?, links }`, with `included` exactly when the read has an `include`. */
export type DataDocument = Handlers.DocumentValue<ResourceValue | null, ResourceValue>;

/** Edge rows by collection, then row id, then edge name (see {@link Input.linkage}). */
export type Linkage = ReadonlyMap<
  string,
  ReadonlyMap<string, Readonly<Record<string, ReadonlyArray<unknown>>>>
>;

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
}

// ─── Row helpers (shared with the linkage derivation) ────────────────────────

/** A row value as a record (a node row always is one). */
const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  P.isObjectOrArray(value) ? (value as Record<string, unknown>) : {};

/** The row id a row value carries (node rows carry `id` in the value). */
export const idOf = (value: unknown): string => String(recordOf(value)["id"]);

/** A resolved edge's value as its rows: a list as it is, a single row alone, `null` / `undefined` as none. */
export const relatedValuesOf = (value: Related.RelatedValue): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];

// ─── Rows → resource objects ─────────────────────────────────────────────────

/** The per-document constants every row is written under. */
interface Env {
  readonly nodes: Node.NodeRegistry;
  readonly linkage: Linkage | undefined;
  readonly prefix: string;
}

const envOf = (input: Input): Env => ({
  nodes: input.nodes,
  linkage: input.linkage,
  prefix: input.prefix ?? "",
});

/** The node's declared attributes off the row value, in declaration order; absent ones are left out. */
const attributesOf = (node: Node.AnyNode, value: Readonly<Record<string, unknown>>) => {
  return R.filterMap(node.attributes, (_, field) => {
    const attribute = value[field];
    return attribute === undefined ? Result.failVoid : Result.succeed(attribute);
  });
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

/**
 * The relationship object of one edge, or `undefined` when nothing is known
 * about it. This is where a row's linkage is read: a `one` edge's key off
 * its `via` field, a collection-valued edge's identifiers off its resolved
 * rows.
 */
const relationshipOf = (
  env: Env,
  node: Node.AnyNode,
  row: Row,
  name: string
): RelationshipValue | undefined => {
  const edge = node.edges[name];
  if (edge === undefined) return undefined;
  if (edge.kind === "one") {
    const key = recordOf(row.value)[edge.via];
    return {
      data: key === undefined || key === null ? null : { type: edge.target, id: String(key) },
    };
  }
  const rows = edgeRowsOf(env, node, row, name);
  const data =
    rows === undefined
      ? undefined
      : { data: rows.map((value) => ({ type: edge.target, id: idOf(value) })) };
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
  const relationships = R.filterMap(node.edges, (_, name) => {
    const relationship = relationshipOf(env, node, row, name);
    return relationship === undefined ? Result.failVoid : Result.succeed(relationship);
  });
  return {
    type: node.type,
    id: row.id,
    attributes: attributesOf(node, recordOf(row.value)),
    ...(R.isEmptyReadonlyRecord(relationships) ? {} : { relationships }),
  };
};

/** The edge rows of one included edge across the root rows, as resources of the target node. */
const includedOf = (
  env: Env,
  node: Node.AnyNode,
  rows: ReadonlyArray<Related.RelatedRow>,
  name: string
): ReadonlyArray<ResourceValue> => {
  const edge = node.edges[name];
  const target = edge === undefined ? undefined : env.nodes.nodes.get(edge.target);
  if (target === undefined) return [];
  return rows.flatMap((row) =>
    relatedValuesOf(row.related[name]).map((related) =>
      resourceOf(env, target, { id: idOf(related), value: related })
    )
  );
};

/** The resource's attributes narrowed to its type's `fields[]` entry, when one is given. */
const project = (
  resource: ResourceValue,
  fields: JsonApiQuery.Projection | undefined
): ResourceValue => {
  const names = fields?.[resource.type];
  if (names === undefined) return resource;
  const attributes = R.filter(resource.attributes, (_, field) => names.includes(field));
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

/**
 * The primary resources and the compound `included`, both projected.
 * `included` is `undefined` for a read with no `include`, so the member is
 * omitted; a read with one gets the array even when it is empty, because a
 * response to a request carrying `include` is a compound document (JSON:API
 * 1.1 §Fetching Includes).
 */
const assemble = (input: Input, node: Node.AnyNode) => {
  const env = envOf(input);
  const data = input.rows.map((row) => project(resourceOf(env, node, row), input.fields));
  const include = input.read.include;
  const included =
    include === undefined
      ? undefined
      : Object.keys(include)
          .toSorted(Predicate.compareText)
          .flatMap((name) => includedOf(env, node, input.rows, name))
          .map((resource) => project(resource, input.fields));
  return { data, included };
};

/** `links.self`: the read's canonical string behind the prefix. */
const selfLink = (input: Input): string =>
  `${input.prefix ?? ""}${JsonApiQuery.canonical(input.nodes, input.read, input.fields)}`;

/**
 * The read's resolved rows sliced to the page it actually asked for
 * (#209). An offset read's root window was compiled with
 * `limit = offset + first` (`Query.plan`'s `rootLimit`) so a covering
 * subscription could be judged by the ordinary limit-prefix rule and the
 * window fetched in one shot; `input.rows` therefore holds up to
 * `offset + first` rows in window order, and this is where they are
 * sliced back down to the `first` rows starting at `offset` — the one
 * place both the derived REST handler and the replica-side writer apply
 * the slice, since both call this module. A cursor-paginated read has no
 * `offset`, so its rows are its page already.
 */
const pageOf = (input: Input): ReadonlyArray<Related.RelatedRow> => {
  const { offset, first } = input.read;
  if (offset === undefined) return input.rows;
  return input.rows.slice(offset, first === undefined ? undefined : offset + first);
};

/**
 * `links.next` for a full page: an offset read continues at `offset +
 * first` in the same idiom it was asked in; a cursor read continues after
 * the page's last row (`page[after]`), the cursor `Subset.apply` resumes
 * from. A short page — fewer rows than `first`, or no window at all — has
 * no next; switching a cursor request to `page[after]`-of-offset (or vice
 * versa) is never done — pagination links stay in the idiom the request
 * used (#209).
 */
const nextLink = (input: Input, page: ReadonlyArray<Related.RelatedRow>): string | undefined => {
  const { first, offset } = input.read;
  if (first === undefined || page.length < first) return undefined;
  const link = (read: Query.Read): string =>
    `${input.prefix ?? ""}${JsonApiQuery.canonical(input.nodes, read, input.fields)}`;
  if (offset !== undefined) return link({ ...input.read, offset: offset + first });
  const last = page.at(-1);
  return last === undefined ? undefined : link({ ...input.read, after: last.id });
};

/**
 * `links.prev` for an offset page past the first: the same query at
 * `max(0, offset - first)`. Cursor pagination has no `prev` — a forward
 * cursor names no way back, and ADR-0029's model is unbounded-forward only
 * (#209 adds `prev` for the offset idiom alone).
 */
const prevLink = (input: Input): string | undefined => {
  const { first, offset } = input.read;
  if (offset === undefined || offset <= 0 || first === undefined) return undefined;
  const read: Query.Read = { ...input.read, offset: Math.max(0, offset - first) };
  return `${input.prefix ?? ""}${JsonApiQuery.canonical(input.nodes, read, input.fields)}`;
};

/**
 * The collection document of a read: every row of its page as primary
 * data, the included edges compounded, `links.self` canonical and
 * `links.next` (and, for an offset read past the first page, `links.prev`)
 * when the page is full. Throws for a read the canonical encoder refuses
 * (a per-edge window, an `Exists`) — such a read has no URL, so it is
 * never one a URL produced.
 */
export const collection = (input: Input): CollectionDocument => {
  const page = pageOf(input);
  const { data, included } = assemble({ ...input, rows: page }, nodeOf(input.nodes, input.read));
  const next = nextLink(input, page);
  const prev = prevLink(input);
  return Handlers.collection(data, {
    ...(included === undefined ? {} : { included }),
    links: {
      self: selfLink(input),
      ...(next === undefined ? {} : { next }),
      ...(prev === undefined ? {} : { prev }),
    },
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
  return Handlers.data(primary[0] ?? null, {
    ...(included === undefined ? {} : { included }),
    links: { self: selfLink(input) },
  });
};
