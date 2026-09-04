/**
 * RestHandlers
 *
 * Derived JSON:API `list` / `get` handlers over the sync engine's read path
 * (issue #163). A JSON:API `GET` is ADR-0025's `read` operation with a
 * document body: the URL is parsed into a `Query.Read` by the one grammar
 * (`JsonApiQuery.parseParams`), the request's identity becomes a
 * `SyncContext`, the read runs through `Query.plan` → the filterable check
 * and the deny-by-default auth filters (`Authorization.authorize`) →
 * `Backend.evaluate` + `getRows` with ADR-0025's two-phase include
 * resolution (`Query.runVia` over `SyncServer.readSubsets` — the very
 * function the protocol's `handleRead` runs), and the rows are serialised
 * by {@link DocumentWriter}. Two carriers, one evaluator, one auth path:
 * what the sync tier syncs for a window is what the REST tier answers for
 * the same URL, so a façade serving that URL from the replica (ADR-0029 §6)
 * can match it.
 *
 * Scoping is the auth policy's, never the handler's: a request without
 * identity to a private collection sees the policy's empty allow-set —
 * an empty collection for `list`, a 404 for `get` — exactly as the sync
 * tier's `isIn(field, [])` behaves. No `WHERE userId` lives here.
 *
 * Sorting and paging are `Subset.apply`'s (ADR-0026 / ADR-0028): code-point
 * text order, NULLs last, the id tie-break, `page[after]` as the cursor —
 * the REST tier inherits them by construction.
 *
 * **Linkage follows the resource's declaration.** effect-jsonapi's resource
 * schemas require every declared relationship on every resource object, so
 * the derivation resolves, beside the URL's includes, the rows of every
 * `Relationship.many` the endpoint's resource declares — on the primary
 * resource, and on each included resource's own declaration — and writes
 * them as linkage, not `included`. A `one` relationship's linkage is the
 * edge's key field and costs nothing. The primary resource's `many`
 * relationships ride in the read's second phase; the included resources'
 * ride in one more batch, keyed by the included rows. Nothing the resource
 * does not declare is resolved, so a collection the URL never named is
 * never touched — neither for its cost nor for its policy verdict. A
 * paginated node edge is served under either declaration: as
 * `Relationship.many` it carries the spec's `links` and its rows' linkage
 * (the edge's declared order) and can be `include`d; as
 * `Relationship.paginated` it carries `links` only and the endpoint's own
 * codec refuses `include=` for it. A declaration the node graph cannot
 * serve (a relationship that is no edge, or of the other kind) is a
 * definition-time defect.
 *
 * **Outcomes the derivation owns.** A URL the grammar rejects is answered
 * with the codec's 400 error document, `source.parameter` naming the
 * offending key, before any backend call; a collection the policy denies
 * (no auth filter declared) is a 403, and within a batch every subset is
 * authorized before any is evaluated. Both are written as JSON:API error
 * responses by the handler — effect-jsonapi's `ApiError` classes carry no
 * `source` member, and every endpoint already declares the 400. A `get`
 * that matches no row fails with the error the caller declares on the
 * endpoint (`notFound`), so the api's own 404 class is what the client
 * decodes. A backend failure is a defect (500), as the hand-written
 * handlers' `orDie` made it.
 *
 * Derivation is opt-in per endpoint: `handlers.handle("list", rest.list(Product))`
 * beside hand-written handlers on the same api.
 */

import { Effect, SchemaError } from "effect";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  ApiError,
  type Document,
  MEDIA_TYPE,
  Middleware,
  type Relationship,
  type Resource,
} from "@thomasfosterau/effect-jsonapi";
import {
  type Authorization,
  AuthorizationError,
  type Backend,
  BackendError,
  Collection,
  type Node,
  Predicate,
  Query,
  QueryError,
} from "@legation/effect";
import { type Related, Subset, SyncServer } from "@legation/effect/internal";
import * as DocumentWriter from "./DocumentWriter.js";
import * as JsonApiQuery from "./JsonApiQuery.js";

// ─── Options ─────────────────────────────────────────────────────────────────

/** What the derived handlers run over: the graph, the read path's seams, and the request's identity. */
export interface Options {
  /** The node graph the URLs are parsed against and the rows are written by. */
  readonly nodes: Node.NodeRegistry;
  /** The storage contract the read evaluates through. */
  readonly backend: Backend.Backend;
  /** The deny-by-default auth policy, with the filterable declarations (#154). */
  readonly policy: Authorization.AuthPolicy;
  /**
   * The identity seam: an HTTP request to the `SyncContext` the auth filters
   * see — the HTTP analogue of `IdentityResolver`, which resolves a client
   * group. Derive `identity` from the verified session (a forwarded header
   * the app trusts, a session token); never from anything a browser can
   * forge. `clientGroupId` names the carrier (`"http"`) or the session.
   */
  readonly context: (
    request: HttpServerRequest
  ) => Effect.Effect<Backend.SyncContext, AuthorizationError>;
  /** The interception seam around reads (`onRead`); absent means passthrough. */
  readonly middleware?: Authorization.SyncMiddleware;
  /** The api's mount path, prepended to every link (`/jsonapi`); default `""`. */
  readonly prefix?: string;
}

/** The handler input a `list` endpoint gives (the rest of the request is not needed). */
export interface ListInput {
  readonly request: HttpServerRequest;
}

/** The handler input a `get` endpoint gives: the `:id` path parameter and the request. */
export interface GetInput {
  readonly params: { readonly id: string };
  readonly request: HttpServerRequest;
}

/** The collection document type of a resource's default `Endpoint.list` success. */
export type CollectionDocumentOf<R extends Resource.Any> = Document.CollectionDocument<
  R,
  Resource.DefaultIncluded<R["relationships"]>,
  typeof Document.AnyMeta
>["Type"];

/** The single-resource document type of a resource's default `Endpoint.get` success. */
export type DataDocumentOf<R extends Resource.Any> = Document.DataDocument<
  R,
  Resource.DefaultIncluded<R["relationships"]>,
  typeof Document.AnyMeta
>["Type"];

/** Options of a derived `get`: the endpoint's own 404. */
export interface GetOptions<E> {
  /** The error to fail with when no row matches — the `ApiError` class the endpoint declares. */
  readonly notFound: () => E;
}

/** The derived handler factories, bound to one graph and one read path. */
export interface RestHandlers {
  /**
   * The `list` handler of a resource: `GET /{type}?…` as a read over the
   * node of the same type. Typed as the resource's default collection
   * document; the endpoint's success encoder checks the document at
   * runtime, so a resource whose declaration disagrees with the node graph
   * (an attribute the node calls an edge) fails there, not silently.
   */
  readonly list: <R extends Resource.Any>(
    resource: R
  ) => (
    input: ListInput
  ) => Effect.Effect<CollectionDocumentOf<R> | HttpServerResponse.HttpServerResponse>;
  /**
   * The `get` handler of a resource: `GET /{type}/{id}?…` as the read
   * `filter[id]={id}`, first 1, taking `include` and `fields[…]` only.
   */
  readonly get: <R extends Resource.Any, E>(
    resource: R,
    options: GetOptions<E>
  ) => (
    input: GetInput
  ) => Effect.Effect<DataDocumentOf<R> | HttpServerResponse.HttpServerResponse, E>;
}

// ─── Error documents ─────────────────────────────────────────────────────────

/** A JSON:API error document value (the shape `ApiError.toDocument` produces). */
export type ErrorDocument = typeof ApiError.WireDocument.Type;

/**
 * The 400 error document of a URL the grammar rejects: the codec's own
 * document (`Middleware.schemaErrorDocument`, one error object per issue,
 * each with `source.parameter`) when the rejection came from decoding; the
 * same shape around the `QueryError`'s message and `parameter` when it came
 * from the graph checks that run before decoding (an undeclared include, a
 * `fields[]` type the read cannot carry). The façade answers a parse failure
 * with this document too (ADR-0029 §1).
 */
export const queryErrorDocument = (error: QueryError): ErrorDocument => {
  if (SchemaError.isSchemaError(error.cause)) {
    return Middleware.schemaErrorDocument("Query", error.cause);
  }
  return {
    errors: [
      {
        status: String(ApiError.BadRequest.status),
        code: ApiError.BadRequest.code,
        ...(ApiError.BadRequest.title === undefined ? {} : { title: ApiError.BadRequest.title }),
        detail: error.message,
        ...(error.parameter === undefined ? {} : { source: { parameter: error.parameter } }),
      },
    ],
  };
};

/** The 403 error document of a collection the policy denies. */
const forbiddenDocument = (error: AuthorizationError): ErrorDocument => ({
  errors: [
    {
      status: String(ApiError.Forbidden.status),
      code: ApiError.Forbidden.code,
      ...(ApiError.Forbidden.title === undefined ? {} : { title: ApiError.Forbidden.title }),
      detail: error.message,
    },
  ],
});

/** An error document as a JSON:API response. */
const errorResponse = (
  status: number,
  document: ErrorDocument
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(document, { status, contentType: MEDIA_TYPE });

// ─── URL → read ──────────────────────────────────────────────────────────────

/** `HttpServerRequest.url` is path + query; any origin makes it parseable. */
const searchParamsOf = (request: HttpServerRequest): URLSearchParams =>
  new URL(request.url, "http://localhost").searchParams;

// ─── Linkage: what the resource declares ─────────────────────────────────────

/**
 * The edges resolved beside the URL's includes, read off the resource's
 * declared relationships: the root resource's `Relationship.many` edges,
 * and per includable relationship, the target resource's own — the edge
 * names each included row's linkage is resolved for.
 */
interface LinkagePlan {
  readonly root: ReadonlyArray<string>;
  readonly included: ReadonlyMap<string, ReadonlyArray<string>>;
}

const declared = (resource: Resource.Any, name: string): string =>
  `RestHandlers: relationship "${name}" of resource "${resource.type}"`;

/**
 * The resource's relationships as node edges, each checked against the
 * node's edge of that name: same name, same arity, same target. Returns
 * the `Relationship.many` names — the edges resolved for linkage.
 */
const manyEdgesOf = (resource: Resource.Any, node: Node.AnyNode): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const [name, descriptor] of Object.entries(resource.relationships) as ReadonlyArray<
    [string, Relationship.Descriptor]
  >) {
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
    if (descriptor.kind === "many") names.push(name);
  }
  return names;
};

/** The linkage plan of a resource over its node (a definition-time check of the whole declaration). */
const linkagePlanOf = (
  nodes: Node.NodeRegistry,
  resource: Resource.Any,
  node: Node.AnyNode
): LinkagePlan => {
  const root = manyEdgesOf(resource, node);
  const included = new Map<string, ReadonlyArray<string>>();
  for (const [name, descriptor] of Object.entries(resource.relationships) as ReadonlyArray<
    [string, Relationship.Descriptor]
  >) {
    if (descriptor.kind === "paginated") continue;
    const target = descriptor.ref();
    included.set(name, manyEdgesOf(target, nodes.nodes.get(target.type)!));
  }
  return { root, included };
};

/** The read the handler runs: the URL's read with the root linkage edges selected beside its includes. */
const withLinkage = (plan: LinkagePlan, read: Query.Read): Query.Read => {
  const include: Record<string, true | Query.IncludeOptions> = {};
  for (const name of plan.root) include[name] = true;
  Object.assign(include, read.include);
  return Object.keys(include).length === 0 ? read : { ...read, include };
};

/** The row id a related value carries (node rows carry `id` in the value). */
const idOf = (value: unknown): string => String((value as { readonly id: unknown }).id);

/** The ids of the rows one included edge resolved across the root rows. */
const includedIds = (
  rows: ReadonlyArray<Related.RelatedRow>,
  name: string
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const row of rows) {
    const value = row.related[name];
    for (const related of Array.isArray(value) ? value : value == null ? [] : [value]) {
      ids.add(idOf(related));
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
  const relationship = Collection.relationshipsOf(nodes.collections, type).get(edge)!;
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
  plan: LinkagePlan,
  node: Node.AnyNode,
  read: Query.Read,
  rows: ReadonlyArray<Related.RelatedRow>
): ReadonlyArray<LinkageQuery> => {
  const queries = new Map<string, LinkageQuery>();
  for (const name of Object.keys(read.include ?? {})) {
    const edges = plan.included.get(name) ?? [];
    const parents = includedIds(rows, name);
    if (edges.length === 0 || parents.size === 0) continue;
    const type = node.edges[name]!.target;
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

// ─── Failures ────────────────────────────────────────────────────────────────

/** An outcome the derivation owns, as a response; a backend failure is a defect. */
const respondToFailures = <A, E>(
  effect: Effect.Effect<A, E | QueryError | AuthorizationError | BackendError>
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, E> =>
  Effect.catch(effect, (error) => {
    if (error instanceof QueryError) {
      return Effect.succeed(errorResponse(ApiError.BadRequest.status, queryErrorDocument(error)));
    }
    if (error instanceof AuthorizationError) {
      return Effect.succeed(errorResponse(ApiError.Forbidden.status, forbiddenDocument(error)));
    }
    if (error instanceof BackendError) return Effect.die(error);
    return Effect.fail(error as E);
  });

// ─── The handlers ────────────────────────────────────────────────────────────

/**
 * Bind the derived handlers to a graph and a read path. The node of a
 * resource is looked up by its `type` when the handler is built and the
 * resource's relationships are checked against the node's edges then, so a
 * declaration the graph cannot serve is a definition-time defect, never a
 * 500.
 */
export const make = (options: Options): RestHandlers => {
  const { nodes, backend, policy, middleware, prefix } = options;
  const deps: SyncServer.ReadDeps = {
    backend,
    authPolicy: policy,
    ...(middleware && { middleware }),
  };

  const nodeOf = (resource: Resource.Any): Node.AnyNode => {
    const node = nodes.nodes.get(resource.type);
    if (node === undefined) {
      throw new Error(`RestHandlers: no node "${resource.type}" in the graph for the resource`);
    }
    return node;
  };

  // ADR-0025's read behind the request's identity: `readSubsets` per batch
  // (filterable check, middleware, auth filters, evaluate + getRows); the
  // two phases and the edge windows by `Query.runVia`; then the included
  // resources' linkage in one more batch.
  const run = (
    context: Backend.SyncContext,
    node: Node.AnyNode,
    plan: LinkagePlan,
    read: Query.Read
  ) => {
    const fetch = (subsets: ReadonlyArray<Subset.Subset>) =>
      SyncServer.readSubsets(deps, context, { clientGroupId: context.clientGroupId, subsets });
    return Effect.gen(function* () {
      const rows = yield* Query.runVia(fetch, nodes, withLinkage(plan, read));
      const queries = linkageQueries(nodes, plan, node, read, rows);
      const fetched =
        queries.length === 0
          ? []
          : yield* fetch(
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
  };

  /** The writer's input for a read's rows (the projection and prefix only when given). */
  const input = (
    read: Query.Read,
    resolved: {
      readonly rows: ReadonlyArray<Related.RelatedRow>;
      readonly linkage: DocumentWriter.Linkage;
    },
    fields: JsonApiQuery.Projection | undefined
  ): DocumentWriter.Input => ({
    nodes,
    read,
    rows: resolved.rows,
    linkage: resolved.linkage,
    ...(fields === undefined ? {} : { fields }),
    ...(prefix === undefined ? {} : { prefix }),
  });

  const list = <R extends Resource.Any>(resource: R) => {
    const node = nodeOf(resource);
    const plan = linkagePlanOf(nodes, resource, node);
    return ({ request }: ListInput) =>
      respondToFailures<CollectionDocumentOf<R>, never>(
        Effect.gen(function* () {
          const context = yield* options.context(request);
          const { read, fields } = yield* JsonApiQuery.parseParams(
            nodes,
            node.type,
            searchParamsOf(request)
          );
          const resolved = yield* run(context, node, plan, read);
          // The endpoint's success encoder checks the document against the
          // resource at runtime; the type here is the default collection
          // document the resource declares.
          return DocumentWriter.collection(
            input(read, resolved, fields)
          ) as unknown as CollectionDocumentOf<R>;
        })
      );
  };

  const get = <R extends Resource.Any, E>(resource: R, { notFound }: GetOptions<E>) => {
    const node = nodeOf(resource);
    const plan = linkagePlanOf(nodes, resource, node);
    return ({ params, request }: GetInput) =>
      respondToFailures<DataDocumentOf<R>, E>(
        Effect.gen(function* () {
          const context = yield* options.context(request);
          const single = yield* JsonApiQuery.singleRowParams(
            node.type,
            params.id,
            searchParamsOf(request)
          );
          const { read, fields } = yield* JsonApiQuery.parseParams(nodes, node.type, single);
          const resolved = yield* run(context, node, plan, read);
          if (resolved.rows.length === 0) return yield* Effect.fail(notFound());
          return DocumentWriter.data(input(read, resolved, fields)) as unknown as DataDocumentOf<R>;
        })
      );
  };

  return { list, get };
};
