/**
 * ReplicaDocuments
 *
 * JSON:API documents written from the **replica** (issue #164): the
 * worker-side caller of {@link DocumentWriter}, the counterpart of the
 * derived REST handlers ({@link RestHandlers}) that write the same
 * documents from the backend. Given the node graph and a local view, a URL
 * (or a parsed read with its `fields[]` projection) runs as a read over the
 * rows the replica holds — `Query.runVia` over the view, the two-phase
 * include of ADR-0025 with the plan's edge windows applied — and its rows
 * are serialised by the one serialiser, so the same URL yields the same
 * document content on either side (ADR-0029 §6). The document sees the
 * optimistic overlay exactly as `Client.query` does (ADR-0029 §4); it
 * depends on nothing but `effect` and the two legation packages, so it runs
 * where the engine runs — a service worker included.
 *
 * **How the replica learns which relationships to emit.** The REST tier
 * derives its linkage from the endpoint's effect-jsonapi resource: every
 * `Relationship.many` the resource declares is resolved beside the URL's
 * includes and written as linkage ({@link Linkage}). The replica takes the
 * same input — a resource declaration per type ({@link Options.resources})
 * — and derives its plan through the same function, so for the same
 * declarations both sides resolve the same edges and write the same bytes
 * by construction; the façade (#166) is built from the app's `HttpApi` and
 * has these declarations at hand. An app that has only the node graph
 * passes nothing and gets `JsonApiQuery.resourcesOf(nodes)`: the synthetic
 * resources whose relationships are the node's edges — every collection
 * edge (paginated ones as `many`) resolved for linkage — which a REST
 * handler built over the same synthetic resources reproduces. A resource
 * the node graph cannot serve is a definition-time defect here as there.
 *
 * **One grammar on both sides.** A URL is parsed with the node-derived
 * codec (`JsonApiQuery.parseRead`), so parity holds when the endpoint is
 * declared with the same codec — `JsonApiQuery.querySchema(nodes,
 * collection)`, or declarations equivalent to it: a filter names the edge's
 * key field (`filter[categoryId]`), `sort` admits the node's sortable set
 * and `id`, and collection edges are `many` (a `paginated` declaration
 * refuses `include=` the node grammar accepts). Where the bound resource
 * declares less than the node — an edge it leaves out, a type it never
 * reaches — the endpoint cannot emit what the URL asks for, so the replica
 * refuses it the same way the codec would: an `include` edge or a
 * `fields[type]` type the resource does not declare is a `QueryError`
 * naming the parameter, raised before the read runs.
 *
 * **What the replica must hold.** The writer resolves everything from the
 * local view and cannot tell a missing row from an absent one, so a
 * document is faithful only when the replica holds every row the read and
 * its linkage need. That is the caller's coverage check (ADR-0029 §3,
 * `Client.coverageOf`): {@link ReplicaDocuments.toCover} names the reads a
 * request needs covered — the URL's read as stated, plus one
 * whole-collection read per collection the declared linkage resolves from
 * beyond the read's includes (the root's declared `many` edges the URL did
 * not include, and every declared `many` edge of each included type). A
 * replica holding each of those whole (under the same auth filter the
 * server applies) answers the linkage exactly as the server does. The
 * requirement is sound and conservative: a pin that holds an edge window
 * without the whole collection is not credited, and a read that is
 * uncovered goes to the network unchanged (ADR-0029 §4). The façade serves
 * a URL only when every read `toCover` lists is covered; this module never
 * decides that itself.
 *
 * A URL is network input, so nothing about it is a defect: a collection no
 * bound resource declares fails every entry point with a `QueryError`, and
 * the façade routes the request to the network.
 */

import { Effect } from "effect";
import type { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";
import { type Node, type Query, QueryError } from "@legation/effect";
import type { ClientView, Subset } from "@legation/effect/internal";
import * as DocumentWriter from "./DocumentWriter.js";
import * as JsonApiQuery from "./JsonApiQuery.js";
import * as Linkage from "./Linkage.js";

/** What the replica-side writer is bound to: the graph, the declarations linkage follows, the link prefix. */
export interface Options {
  /** The node graph URLs are parsed against, reads compile through and rows are written by. */
  readonly nodes: Node.NodeRegistry;
  /**
   * The resource declarations linkage follows, by type — the resources the
   * app's REST endpoints are declared with, so the replica emits exactly
   * the relationships the derived REST handler emits. Default: the node
   * graph's synthetic resources (`JsonApiQuery.resourcesOf(nodes)`), every
   * collection edge resolved. Every resource is checked against its node
   * when the writer is built; a read on a type no resource declares fails
   * with a `QueryError`.
   */
  readonly resources?: ReadonlyMap<string, Resource.Any>;
  /** The api's mount path, prepended to every link (`/jsonapi`); default `""`. */
  readonly prefix?: string;
}

/** A document a URL yields: a collection document for `/{type}`, a single-resource document for `/{type}/{id}`. */
export type Document = DocumentWriter.CollectionDocument | DocumentWriter.DataDocument;

/** The replica-side writer, bound to one graph and one set of declarations. */
export interface ReplicaDocuments {
  /**
   * Run a parsed read over the view and write its collection document.
   * Fails with a `QueryError` for a collection no bound resource declares,
   * or an `include` / `fields[type]` the bound resource does not declare.
   */
  readonly collection: (
    view: ClientView.Reader,
    parsed: JsonApiQuery.ParsedRead
  ) => Effect.Effect<DocumentWriter.CollectionDocument, QueryError>;
  /**
   * Run a parsed read over the view and write its single-resource document:
   * the first row, or `data: null` when the replica holds no matching row
   * (the caller decides the 404). Fails as {@link ReplicaDocuments.collection}.
   */
  readonly data: (
    view: ClientView.Reader,
    parsed: JsonApiQuery.ParsedRead
  ) => Effect.Effect<DocumentWriter.DataDocument, QueryError>;
  /**
   * Parse a URL (`JsonApiQuery.parseRead`: the read and its `fields[]`
   * projection together) and write the document it addresses — a
   * single-resource document for `/{type}/{id}`, a collection document
   * otherwise. Fails with the `QueryError` the grammar gives, naming the
   * parameter, for a URL the server would reject the same way; and as
   * {@link ReplicaDocuments.collection} for what the bound resource does
   * not declare.
   */
  readonly fromUrl: (
    view: ClientView.Reader,
    url: string | URL
  ) => Effect.Effect<Document, QueryError>;
  /**
   * The reads a request needs covered for its document to be faithful: the
   * read as stated, then one whole-collection read per collection the
   * declared linkage resolves from beyond the read's includes (see the
   * module doc). The caller checks each with `Client.coverageOf`. Fails
   * with a `QueryError` for a collection no bound resource declares — a
   * request the façade sends to the network.
   */
  readonly toCover: (read: Query.Read) => Effect.Effect<ReadonlyArray<Query.Read>, QueryError>;
}

/**
 * The local view as a row source: each subset evaluated over the replica
 * (confirmed rows with the optimistic overlay), rows tagged with their
 * collection, batches concatenated in subset order — the shape
 * `SyncServer.readSubsets` gives the REST tier. The subsets of a batch are
 * independent, so they run concurrently. A store failure is a defect, as
 * `Query.run` treats it.
 */
export const fetchOf =
  (view: ClientView.Reader): Linkage.Fetch<never> =>
  (subsets: ReadonlyArray<Subset.Subset>) =>
    Effect.forEach(
      subsets,
      (subset) =>
        view.query(subset).pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((row) => ({ collection: subset.collection, id: row.id, value: row.value }))
          )
        ),
      { concurrency: "unbounded" }
    ).pipe(Effect.map((batches) => batches.flat()));

// ─── The bound declarations ──────────────────────────────────────────────────

/** One type as the writer serves it: its node, its resource, and the linkage plan derived from both. */
interface Binding {
  readonly node: Node.AnyNode;
  readonly resource: Resource.Any;
  readonly plan: Linkage.Plan;
}

/** Every resource bound to its node (a definition-time check of each declaration). */
const bindAll = (
  nodes: Node.NodeRegistry,
  resources: ReadonlyMap<string, Resource.Any>
): ReadonlyMap<string, Binding> => {
  const bindings = new Map<string, Binding>();
  for (const resource of resources.values()) {
    const node = nodes.nodes.get(resource.type);
    if (node === undefined) {
      throw new Error(`ReplicaDocuments: no node "${resource.type}" in the graph for the resource`);
    }
    bindings.set(resource.type, { node, resource, plan: Linkage.planOf(nodes, resource, node) });
  }
  return bindings;
};

const descriptorsOf = (resource: Resource.Any): Readonly<Record<string, Relationship.Descriptor>> =>
  resource.relationships as Readonly<Record<string, Relationship.Descriptor>>;

/** The types a resource's document can carry: its own and its relationships' targets. */
const carriedTypes = (resource: Resource.Any): ReadonlyArray<string> => [
  resource.type,
  ...Object.values(descriptorsOf(resource)).map((descriptor) => descriptor.ref().type),
];

/**
 * The rejection of what the bound resource does not declare, in the codec's
 * shape: an `include` edge that is no relationship of the resource, or a
 * `fields[type]` type its document cannot carry. Checked before the read
 * runs, so a refused request costs no query.
 */
const undeclared = (binding: Binding, parsed: JsonApiQuery.ParsedRead): QueryError | undefined => {
  const { resource } = binding;
  const relationships = descriptorsOf(resource);
  for (const name of Object.keys(parsed.read.include ?? {})) {
    if (relationships[name] === undefined) {
      return JsonApiQuery.invalidParameter(
        resource.type,
        "include",
        `"${name}" is not a relationship the "${resource.type}" resource declares (relationships: ${Object.keys(relationships).join(", ")})`
      );
    }
  }
  const types = carriedTypes(resource);
  for (const type of Object.keys(parsed.fields ?? {})) {
    if (!types.includes(type)) {
      return JsonApiQuery.invalidParameter(
        resource.type,
        `fields[${type}]`,
        `"${type}" is not a type the "${resource.type}" resource can carry (types: ${types.join(", ")})`
      );
    }
  }
  return undefined;
};

/** Bind the replica-side writer to a graph and its declarations (a definition-time check of every declaration). */
export const make = (options: Options): ReplicaDocuments => {
  const { nodes, prefix } = options;
  const bindings = bindAll(nodes, options.resources ?? JsonApiQuery.resourcesOf(nodes));

  /** The binding of a read's collection; a type nothing declares is the URL's failure, not a defect. */
  const bound = (read: Query.Read): Effect.Effect<Binding, QueryError> => {
    const binding = bindings.get(read.collection);
    return binding === undefined
      ? Effect.fail(
          new QueryError({
            message: `No resource declares "${read.collection}"; the replica cannot serve it`,
            query: read.collection,
          })
        )
      : Effect.succeed(binding);
  };

  /** The binding of a parsed read, with what the resource does not declare refused. */
  const checked = (parsed: JsonApiQuery.ParsedRead): Effect.Effect<Binding, QueryError> =>
    Effect.flatMap(bound(parsed.read), (binding) => {
      const error = undeclared(binding, parsed);
      return error === undefined ? Effect.succeed(binding) : Effect.fail(error);
    });

  /** The writer's input for a parsed read's rows off the view. */
  const input = (
    view: ClientView.Reader,
    parsed: JsonApiQuery.ParsedRead
  ): Effect.Effect<DocumentWriter.Input, QueryError> =>
    Effect.flatMap(checked(parsed), ({ node, plan }) =>
      Linkage.resolve(fetchOf(view), nodes, node, plan, parsed.read).pipe(
        Effect.map((resolved) => ({
          nodes,
          read: parsed.read,
          rows: resolved.rows,
          linkage: resolved.linkage,
          ...(parsed.fields === undefined ? {} : { fields: parsed.fields }),
          ...(prefix === undefined ? {} : { prefix }),
        }))
      )
    );

  const collection: ReplicaDocuments["collection"] = (view, parsed) =>
    Effect.map(input(view, parsed), DocumentWriter.collection);

  const data: ReplicaDocuments["data"] = (view, parsed) =>
    Effect.map(input(view, parsed), DocumentWriter.data);

  const fromUrl: ReplicaDocuments["fromUrl"] = (view, url) =>
    JsonApiQuery.parseRead(nodes, url).pipe(
      Effect.flatMap(
        (parsed): Effect.Effect<Document, QueryError> =>
          parsed.id === undefined ? collection(view, parsed) : data(view, parsed)
      )
    );

  const toCover: ReplicaDocuments["toCover"] = (read) =>
    Effect.map(bound(read), ({ node, plan }) => [
      read,
      ...Linkage.collectionsOf(nodes, node, plan, read).map((name) => ({ collection: name })),
    ]);

  return { collection, data, fromUrl, toCover };
};
