/**
 * Linkage
 *
 * What a document's relationships are resolved from beside the URL's
 * includes — shared by the derived REST handlers ({@link RestHandlers}) and
 * the replica-side writer ({@link ReplicaDocuments}), so both sides resolve
 * the same edges for the same declarations and the one serialiser
 * ({@link DocumentWriter}) writes the same bytes (ADR-0029 §6).
 *
 * **Linkage follows the resource's declaration.** effect-jsonapi's resource
 * schemas require every declared relationship on every resource object, so
 * a read resolves, beside its includes, the rows of every `Relationship.many`
 * the resource declares — on the primary resource, and on each included
 * resource's own declaration — and writes them as linkage, not `included`.
 * A `one` relationship's linkage is the edge's key field and costs nothing.
 * The primary resource's `many` relationships ride in the read's second
 * phase (they are selected beside its includes, {@link withLinkage}); the
 * included resources' ride in one more batch keyed by the included rows
 * ({@link resolve}). Nothing the resource does not declare is resolved, so a
 * collection the URL never named is never touched — neither for its cost
 * nor for its policy verdict. A paginated node edge is served under either
 * declaration: as `Relationship.many` it carries the spec's `links` and its
 * rows' linkage (the edge's declared order) and can be `include`d; as
 * `Relationship.paginated` it carries `links` only.
 *
 * A declaration the node graph cannot serve (a relationship that is no
 * edge, or of the other kind, or targeting another type) is a
 * definition-time defect ({@link planOf} throws).
 *
 * The rows come from a {@link Fetch}: the server's authorized batch
 * evaluation on the REST side (`SyncServer.readSubsets`), the replica's
 * local view on the worker side. One plan, one join, whichever source
 * answers (ADR-0025).
 *
 * Package-internal: the two callers import it directly; nothing outside
 * `@thomasfosterau/legation-jsonapi` derives linkage.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import type { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import { Collection, type Node, Predicate, Query } from "@thomasfosterau/legation-effect";
import { type Related, Subset } from "@thomasfosterau/legation-effect/internal";
import * as DocumentWriter from "./DocumentWriter.js";

/** A batch of subsets evaluated to rows — the row source a read runs over. */
export type Fetch<E> = (
  subsets: ReadonlyArray<Subset.Subset>
) => Effect.Effect<ReadonlyArray<Related.SourcedRow>, E>;

/**
 * The edges resolved beside the URL's includes, read off the resource's
 * declared relationships: the root resource's `Relationship.many` edges,
 * and per includable relationship, the target resource's own — the edge
 * names each included row's linkage is resolved for.
 */
export interface Plan {
  readonly root: ReadonlyArray<string>;
  readonly included: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** The read's rows with the included resources' linkage resolved beside them. */
export interface Resolved {
  readonly rows: ReadonlyArray<Related.RelatedRow>;
  readonly linkage: DocumentWriter.Linkage;
}

// ─── The plan: what the resource declares ────────────────────────────────────

const declared = (resource: Resource.Any, name: string): string =>
  `Linkage: relationship "${name}" of resource "${resource.type}"`;

const descriptorsOf = (
  resource: Resource.Any
): ReadonlyArray<readonly [string, Relationship.Descriptor]> =>
  Object.entries(resource.relationships) as ReadonlyArray<[string, Relationship.Descriptor]>;

/** One declared relationship checked against the node's edge of that name: same name, same arity, same target. */
const checkDeclaration = (
  resource: Resource.Any,
  node: Node.AnyNode,
  name: string,
  descriptor: Relationship.Descriptor
): void => {
  const edge = node.edges[name];
  if (edge === undefined) {
    throw new Error(`${declared(resource, name)} is not an edge of the "${node.type}" node`);
  }
  const toMany = descriptor.kind === "many" || descriptor.kind === "paginated";
  if (toMany === (edge.kind === "one")) {
    throw new Error(
      `${declared(resource, name)} is "${descriptor.kind}" but the node edge is "${edge.kind}"`
    );
  }
  if (descriptor.ref().type !== edge.target) {
    throw new Error(
      `${declared(resource, name)} targets "${descriptor.ref().type}" but the node edge targets "${edge.target}"`
    );
  }
};

/**
 * The resource's relationships as node edges, each checked against the
 * node's edge of that name. Returns the `Relationship.many` names — the
 * edges resolved for linkage.
 */
const manyEdgesOf = (resource: Resource.Any, node: Node.AnyNode): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const [name, descriptor] of descriptorsOf(resource)) {
    checkDeclaration(resource, node, name, descriptor);
    if (descriptor.kind === "many") names.push(name);
  }
  return names;
};

/** The linkage plan of a resource over its node (a definition-time check of the whole declaration). */
export const planOf = (
  nodes: Node.NodeRegistry,
  resource: Resource.Any,
  node: Node.AnyNode
): Plan => {
  const root = manyEdgesOf(resource, node);
  const included = new Map<string, ReadonlyArray<string>>();
  for (const [name, descriptor] of descriptorsOf(resource)) {
    if (descriptor.kind === "paginated") continue;
    const target = descriptor.ref();
    const targetNode = nodes.nodes.get(target.type);
    if (targetNode === undefined) continue;
    included.set(name, manyEdgesOf(target, targetNode));
  }
  return { root, included };
};

/** The read to run: the URL's read with the root linkage edges selected beside its includes. */
export const withLinkage = (plan: Plan, read: Query.Read): Query.Read => {
  const include: Record<string, true | Query.IncludeOptions> = {};
  for (const name of plan.root) include[name] = true;
  Object.assign(include, read.include);
  return R.isEmptyReadonlyRecord(include) ? read : { ...read, include };
};

/**
 * The collections the declared linkage is resolved from beyond the read's
 * own includes: the targets of the root's declared `many` edges the read
 * does not include, and of every declared `many` edge of each included
 * type. A replica that holds each of these whole answers the linkage
 * exactly as the server does — the coverage requirement
 * `ReplicaDocuments.toCover` states.
 */
export const collectionsOf = (
  nodes: Node.NodeRegistry,
  node: Node.AnyNode,
  plan: Plan,
  read: Query.Read
): ReadonlyArray<string> => {
  const collections = new Set<string>();
  const included = read.include ?? {};
  for (const name of plan.root) {
    const edge = node.edges[name];
    if (included[name] === undefined && edge !== undefined) collections.add(edge.target);
  }
  for (const name of Object.keys(included)) {
    const via = node.edges[name];
    const target = via === undefined ? undefined : nodes.nodes.get(via.target);
    if (target === undefined) continue;
    for (const edge of plan.included.get(name) ?? []) {
      const next = target.edges[edge];
      if (next !== undefined) collections.add(next.target);
    }
  }
  return [...collections];
};

// ─── The included resources' batch ───────────────────────────────────────────

/** The ids of the rows one included edge resolved across the root rows. */
const includedIds = (
  rows: ReadonlyArray<Related.RelatedRow>,
  name: string
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const related of DocumentWriter.relatedValuesOf(row.related[name])) {
      ids.add(DocumentWriter.idOf(related));
    }
  }
  return ids;
};

/** One subset of the included-linkage batch: an edge's rows for a set of included parents. */
interface LinkageQuery {
  readonly type: string;
  readonly edge: string;
  readonly collection: string;
  readonly field: string;
  readonly order: ReadonlyArray<Subset.OrderBy>;
  readonly parents: Set<string>;
}

/** Add an included type's `many` edge to the batch for a set of parents, merging into the entry the batch already has. */
const addLinkageQuery = (
  nodes: Node.NodeRegistry,
  queries: Map<string, LinkageQuery>,
  type: string,
  edge: string,
  parents: ReadonlySet<string>
): void => {
  const key = `${type}\0${edge}`;
  const existing = queries.get(key);
  if (existing !== undefined) {
    for (const id of parents) existing.parents.add(id);
    return;
  }
  const relationship = Collection.relationshipsOf(nodes.collections, type).get(edge);
  if (relationship === undefined) return;
  queries.set(key, {
    type,
    edge,
    collection: relationship.collection,
    field: relationship.foreignField,
    order: relationship.order ?? [],
    parents: new Set(parents),
  });
};

/** The included-linkage batch a read needs: one subset per (included type, `many` edge), parents merged. */
const linkageQueries = (
  nodes: Node.NodeRegistry,
  plan: Plan,
  node: Node.AnyNode,
  read: Query.Read,
  rows: ReadonlyArray<Related.RelatedRow>
): ReadonlyArray<LinkageQuery> => {
  const queries = new Map<string, LinkageQuery>();
  for (const name of Object.keys(read.include ?? {})) {
    const edges = plan.included.get(name) ?? [];
    const parents = includedIds(rows, name);
    if (Arr.isReadonlyArrayEmpty(edges) || parents.size === 0) continue;
    const type = node.edges[name]?.target;
    if (type === undefined) continue;
    for (const edge of edges) addLinkageQuery(nodes, queries, type, edge, parents);
  }
  return [...queries.values()];
};

/** The fetched rows of the batch, assigned to their parents: every parent gets every edge, empty or not. */
const assignLinkage = (
  queries: ReadonlyArray<LinkageQuery>,
  fetched: ReadonlyArray<Related.SourcedRow>
): DocumentWriter.Linkage => {
  const linkage = new Map<string, Map<string, Record<string, Array<unknown>>>>();
  const bucket = (type: string, parent: string, edge: string): Array<unknown> => {
    const byId = linkage.get(type) ?? new Map<string, Record<string, Array<unknown>>>();
    linkage.set(type, byId);
    const edges = byId.get(parent) ?? {};
    byId.set(parent, edges);
    return (edges[edge] ??= []);
  };
  for (const query of queries) {
    for (const parent of query.parents) bucket(query.type, parent, query.edge);
    for (const row of fetched) {
      if (row.collection !== query.collection) continue;
      const parent = String((row.value as Record<string, unknown>)[query.field]);
      if (query.parents.has(parent)) bucket(query.type, parent, query.edge).push(row.value);
    }
  }
  return linkage;
};

/**
 * Run a read over a row source with the linkage its resource declares:
 * the read's two phases (`Query.runVia`, the root linkage edges selected
 * beside the includes), then the included resources' `many` edges in one
 * more batch, keyed by the included rows. The rows and the linkage are
 * exactly what {@link DocumentWriter} takes.
 */
export const resolve = <E>(
  fetchRows: Fetch<E>,
  nodes: Node.NodeRegistry,
  node: Node.AnyNode,
  plan: Plan,
  read: Query.Read
): Effect.Effect<Resolved, E> =>
  Effect.gen(function* () {
    const rows = yield* Query.runVia(fetchRows, nodes, withLinkage(plan, read));
    const queries = linkageQueries(nodes, plan, node, read, rows);
    const fetched = Arr.isReadonlyArrayEmpty(queries)
      ? []
      : yield* fetchRows(
          queries.map((query) =>
            Subset.make({
              collection: query.collection,
              where: Predicate.isIn(query.field, [...query.parents]),
              orderBy: query.order,
            })
          )
        );
    return { rows, linkage: assignLinkage(queries, fetched) };
  });
