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
 * **Linkage follows the resource's declaration** ({@link Linkage}, shared
 * with the replica-side writer): beside the URL's includes, the rows of
 * every `Relationship.many` the endpoint's resource declares are resolved —
 * on the primary resource, and on each included resource's own declaration
 * — and written as linkage, not `included`; nothing the resource does not
 * declare is touched. A paginated node edge under `Relationship.paginated`
 * carries `links` only, and the endpoint's own codec refuses `include=`
 * for it. A declaration the node graph cannot serve is a definition-time
 * defect, thrown when the handler is built.
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

import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  ApiError,
  type Document,
  MEDIA_TYPE,
  Middleware,
  type Resource,
} from "@thomasfosterau/effect-jsonapi";
import {
  type Authorization,
  AuthorizationError,
  type Backend,
  BackendError,
  type Node,
  type Query,
  QueryError,
} from "@legation/effect";
import { type Subset, SyncServer } from "@legation/effect/internal";
import * as DocumentWriter from "./DocumentWriter.js";
import * as JsonApiQuery from "./JsonApiQuery.js";
import * as Linkage from "./Linkage.js";

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
  if (Schema.isSchemaError(error.cause)) {
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
  // (filterable check, middleware, auth filters, evaluate + getRows) is the
  // row source; the two phases, the edge windows and the included
  // resources' linkage batch are `Linkage.resolve`'s — the same steps the
  // replica-side writer (`ReplicaDocuments`) runs over the local view.
  const run = (
    context: Backend.SyncContext,
    node: Node.AnyNode,
    plan: Linkage.Plan,
    read: Query.Read
  ): Effect.Effect<Linkage.Resolved, AuthorizationError | BackendError> =>
    Linkage.resolve(
      (subsets: ReadonlyArray<Subset.Subset>) =>
        SyncServer.readSubsets(deps, context, { clientGroupId: context.clientGroupId, subsets }),
      nodes,
      node,
      plan,
      read
    );

  /** The writer's input for a read's rows (the projection and prefix only when given). */
  const input = (
    read: Query.Read,
    resolved: Linkage.Resolved,
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
    const plan = Linkage.planOf(nodes, resource, node);
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
    const plan = Linkage.planOf(nodes, resource, node);
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
