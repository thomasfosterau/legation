/**
 * JsonApiFacade
 *
 * The façade of ADR-0029 (issue #166): a fetch handler that answers a
 * JSON:API `GET` from the replica when an explicit subscription covers it,
 * and stays out of the way otherwise. A service worker composes it into its
 * `fetch` listener **first**, before the HTTP cache and the network, so a
 * cached copy never becomes a second source of truth for a locally
 * answerable document (ADR-0029 §1).
 *
 * The handler is built from the app's `HttpApi` and the replica it reads:
 *
 * 1. **Route reflection.** `Convention.reflectResources(api)` gives the
 *    `list` and `getOne` routes per type; those whose type is a node of the
 *    graph are kept, so a route the replica cannot read (a server-only
 *    resource) is never the façade's. A request is its business iff its
 *    method is `GET`, its `Accept` names `application/vnd.api+json`, and its
 *    path — under {@link Options.baseUrl} — matches one of those route
 *    templates segment for segment. Anything else yields `undefined` and
 *    the caller composes what comes next.
 * 2. **Parse.** The URL becomes a `Query.Read` through the one grammar
 *    (`JsonApiQuery.parseRead`). A URL the grammar rejects is answered with
 *    the codec's 400 error document (`RestHandlers.queryErrorDocument`),
 *    whether or not the request is covered, because the server rejects it
 *    identically — except an `include` the graph does not declare, which
 *    goes to the network where the server rules on it (ADR-0029 §1), and a
 *    path the graph cannot place, likewise.
 * 3. **Coverage.** Every read `ReplicaDocuments.toCover` names for the
 *    request — the read itself and the whole collections its declared
 *    linkage resolves from — is checked with {@link Options.coverageOf}, the
 *    ledger's verdict (`Client.coverageOf`, or `Coverage.coverageOf` over
 *    the registrations an `EngineHost` holds on mirrors' behalf). One
 *    uncovered read sends the request to the network unchanged.
 * 4. **Answer.** A covered read runs over the view — confirmed rows with the
 *    optimistic overlay, exactly what `Client.query` sees for a covered read
 *    — and is serialised by the one writer, so the document's content is
 *    byte-equal to the derived REST handler's for the same declarations
 *    (ADR-0029 §6). The response is `200` `application/vnd.api+json` with
 *    `Cache-Control: no-store` (the replica is the cache) and
 *    `x-legation-served-at: <cookie>`, the replica's CVR cookie at the time
 *    of the answer, so devtools and tests can
 *    tell a local answer from a network one.
 * 5. **Offline.** An uncovered request while the network is unreachable —
 *    `navigator.onLine === false` here, or a forwarded fetch that rejected
 *    at the transport in the caller ({@link FetchHandler.offline}) — is
 *    answered with the 503 `offline` error document, the one error the
 *    façade synthesises that the server never would (ADR-0029 §4). A status
 *    code from the server is never offline, and a covered request is never
 *    affected by connectivity.
 *
 * **The parity assumption.** Answering a parse failure locally, and a
 * covered request at all, presumes the server rules on the same URL the
 * same way: its read endpoints are declared with the graph's own codec
 * (`JsonApiQuery.querySchema` for a `list`, `singleRowSchema` for a `get`)
 * and served by the derived handlers (`RestHandlers`), as the commerce
 * example does. A hand-written server with another grammar — a filter key
 * the node does not declare, a `sort` the codec refuses, a different `page`
 * vocabulary — must not compose the façade: its 400s and its documents
 * would diverge from the server's.
 *
 * What it never does: register a subscription because a request arrived,
 * touch a non-`GET`, or rewrite a request it forwards. A single-resource
 * request whose row the covered replica does not hold is forwarded too: the
 * 404 is the endpoint's own error class, which only the server can write.
 *
 * It lives in `@thomasfosterau/legation-jsonapi` rather than `@thomasfosterau/legation-browser` by
 * ADR-0006's rule: its dependencies are this package's (the codec, the
 * writer, route reflection) plus the standard `Request` / `Response`
 * globals, and the one browser-only reading — `navigator.onLine` — is an
 * option with a guarded default. `@thomasfosterau/legation-browser` therefore stays free of
 * effect-jsonapi; its `ServiceWorkerHost.start` hands a worker what this
 * handler needs from the host.
 */

import { Effect, Schema } from "effect";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { MEDIA_TYPE, type Resource } from "@thomasfosterau/effect-jsonapi";
import { Query } from "@thomasfosterau/legation-effect";
import type { Node, QueryError } from "@thomasfosterau/legation-effect";
import type { ClientEngine, ClientView, Coverage } from "@thomasfosterau/legation-effect/internal";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as Convention from "./Convention.js";
import * as JsonApiQuery from "./JsonApiQuery.js";
import * as ReplicaDocuments from "./ReplicaDocuments.js";
import * as RestHandlers from "./RestHandlers.js";

// ─── Options ─────────────────────────────────────────────────────────────────

/** What the façade is built from: the api's routes, the graph, the replica and its ledger. */
export interface Options<Id extends string, Groups extends HttpApiGroup.Constraint> {
  /** The node graph URLs are parsed against and documents are written by. */
  readonly nodes: Node.NodeRegistry;
  /**
   * The app's api; its `list` / `getOne` routes (the api's own prefix
   * included) whose type is a node of the graph are what the façade
   * recognises. Its read endpoints must be declared with the graph's codec
   * (the module doc's parity assumption).
   */
  readonly api: HttpApi.HttpApi<Id, Groups>;
  /**
   * Where the api is served as the browser sees it, in front of the routes
   * the api declares: an origin (`https://api.example.com`), an
   * origin-relative path (`/proxy`), or `""` (default) for the page's own
   * origin with no extra path.
   */
  readonly baseUrl?: string;
  /** The replica a covered read runs over: `ClientView.fromEngine(engine)` in a worker, `client.view` over a Client. */
  readonly view: ClientView.Reader;
  /**
   * The ledger's verdict for a read — `client.coverageOf`, or
   * `Coverage.coverageOf(nodes, view.query, host.registrations)` over the registrations
   * an `EngineHost` holds on mirrors' behalf. A request is answered locally
   * only when every read it needs is covered. `options.snapshot` is the root
   * rows the façade read for the request, with their subset: the verdict is
   * judged over them for that subset (#426), and any other read is judged as usual.
   */
  readonly coverageOf: (
    read: Query.Read,
    options?: Coverage.JudgeOptions
  ) => Effect.Effect<Coverage.Verdict>;
  /**
   * The replica's CVR cookie, for `x-legation-served-at` — the store's
   * `getCookie`, read only when a response is synthesised. Absent, or
   * failing, the header is empty.
   */
  readonly cookie?: Effect.Effect<string | undefined, unknown>;
  /**
   * The resource declarations linkage follows — those the api's endpoints
   * are declared with, so the replica writes the relationships the server
   * writes. Default: the graph's synthetic resources (see `ReplicaDocuments`).
   */
  readonly resources?: ReadonlyMap<string, Resource.Any>;
  /**
   * The prefix of every link in a document. Default: the matched route's
   * own prefix (`/jsonapi` for a route `/jsonapi/products`), which is what
   * a server mounting the api at its declared prefix writes.
   */
  readonly prefix?: string;
  /** Whether the network is reachable; default `navigator.onLine !== false` (reachable where there is no `navigator`). */
  readonly online?: () => boolean;
}

/** The built façade. */
export interface FetchHandler {
  /**
   * Whether a request is the façade's business: a `GET` accepting
   * `application/vnd.api+json` on a reflected route under `baseUrl`. A
   * worker uses it to know that a forward which rejected at the transport
   * should become {@link FetchHandler.offline}.
   */
  readonly matches: (request: Request) => boolean;
  /**
   * The façade's answer: a document (200), the codec's 400 for a URL the
   * grammar rejects, or the 503 `offline` document for an uncovered request
   * while offline — or `undefined` when the request is not the façade's
   * business or is uncovered and online, for the caller to forward
   * unchanged. A store failure while reading the replica is a defect, as
   * `Query.run` treats it.
   */
  readonly handle: (request: Request) => Effect.Effect<Response | undefined>;
  /**
   * The 503 `offline` response with the replica's current cookie — what a
   * worker answers when the forward of a request {@link matches} held for
   * rejected at the transport, the other half of ADR-0029 §4's definition.
   */
  readonly offline: Effect.Effect<Response>;
}

// ─── Headers and documents ───────────────────────────────────────────────────

/** The header a locally served response carries: the replica's CVR cookie at the time of the answer. */
export const servedAtHeader = "x-legation-served-at";

/** The 503 error document of an uncovered request while offline (ADR-0029 §4). */
export const offlineDocument: RestHandlers.ErrorDocument = {
  errors: [
    {
      status: "503",
      code: "offline",
      title: "Service unavailable",
      detail: "The request is not covered by a local subscription and the network is unreachable.",
    },
  ],
};

/** Every response the façade synthesises: JSON:API, never cached, marked as served locally. */
const respondWith = (status: number, body: unknown, cookie: string | undefined): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": MEDIA_TYPE,
      "cache-control": "no-store",
      [servedAtHeader]: cookie ?? "",
    },
  });

/** The 503 response of an uncovered request while offline, marked with the cookie when known. */
export const offlineResponse = (cookie?: string): Response =>
  respondWith(503, offlineDocument, cookie);

// ─── Routes ──────────────────────────────────────────────────────────────────

/** One reflected read route, ready to match a request path against. */
interface Route {
  readonly type: string;
  /** The template's segments (`Convention.segmentsOf`); a `:param` segment matches any one. */
  readonly segments: ReadonlyArray<string>;
  /** The link prefix the route implies: the template before `/{type}`. */
  readonly prefix: string;
}

const routeOf = (type: string, template: string, single: boolean): Route => {
  const segments = Convention.segmentsOf(template);
  const prefix = segments.slice(0, segments.length - (single ? 2 : 1));
  return { type, segments, prefix: prefix.length === 0 ? "" : `/${prefix.join("/")}` };
};

/** The read routes of the api whose type the graph declares: a `list` and a `getOne` per such resource. */
const routesOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  nodes: Node.NodeRegistry
): ReadonlyArray<Route> => {
  const routes: Array<Route> = [];
  for (const resource of Convention.reflectResources(api).values()) {
    if (!nodes.nodes.has(resource.type)) continue;
    if (resource.list !== undefined) routes.push(routeOf(resource.type, resource.list.path, false));
    if (resource.getOne !== undefined) {
      routes.push(routeOf(resource.type, resource.getOne.path, true));
    }
  }
  return routes;
};

const matchesTemplate = (route: Route, segments: ReadonlyArray<string>): boolean =>
  route.segments.length === segments.length &&
  route.segments.every((template, index) =>
    Convention.isParam(template) ? true : template === segments[index]
  );

/** Where the api is served: an origin to require, and the path in front of the routes. */
interface Base {
  readonly origin?: string;
  readonly path: string;
}

const baseOf = (baseUrl: string): Base => {
  if (baseUrl === "" || baseUrl.startsWith("/")) return { path: baseUrl.replace(/\/+$/, "") };
  const url = new URL(baseUrl);
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
};

/**
 * The request path relative to the base, or `undefined` when it lies
 * elsewhere. A trailing slash is left to the server: the route templates
 * carry none, and whether `/products/` is `/products` is its ruling.
 */
const pathUnder = (base: Base, url: URL): string | undefined => {
  if (base.origin !== undefined && url.origin !== base.origin) return undefined;
  if (!url.pathname.startsWith(base.path) || url.pathname.endsWith("/")) return undefined;
  const rest = url.pathname.slice(base.path.length);
  return rest.startsWith("/") ? rest : undefined;
};

// ─── Requests ────────────────────────────────────────────────────────────────

/** Whether an `Accept` header names the JSON:API media type (parameters aside). */
const acceptsJsonApi = (header: string | null): boolean =>
  header !== null &&
  header.split(",").some((part) => part.trim().split(";")[0]!.trim().toLowerCase() === MEDIA_TYPE);

const navigatorOnline = (): boolean => {
  const navigator = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return navigator?.onLine !== false;
};

/** A candidate request: the route it matched and its URL, parsed once. */
interface Candidate {
  readonly route: Route;
  readonly url: URL;
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/** How a candidate request leaves the façade short of a document: forwarded, or answered with an error. */
type Outcome =
  { readonly _tag: "Forward" } | { readonly _tag: "Respond"; readonly response: Response };

const forward: Outcome = { _tag: "Forward" };
const respond = (response: Response): Outcome => ({ _tag: "Respond", response });

/**
 * A grammar rejection as the server would rule on it. An `include` the
 * graph does not declare is the server's call (ADR-0029 §1), and so is a
 * path the graph cannot place (no parameter, no decoding issue: the URL
 * names something the graph does not); anything else is the codec's 400,
 * which the server returns identically.
 */
const queryFailure = (error: QueryError, cookie: string | undefined): Outcome =>
  error.parameter === "include" ||
  (error.parameter === undefined && !Schema.isSchemaError(error.cause))
    ? forward
    : respond(respondWith(400, RestHandlers.queryErrorDocument(error), cookie));

// ─── The handler ─────────────────────────────────────────────────────────────

/**
 * Build the façade over an api and a replica. Route reflection and the
 * writer's declaration checks run here, so a declaration the graph cannot
 * serve is a definition-time defect, never a response.
 */
export const fetchHandler = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  options: Options<Id, Groups>
): FetchHandler => {
  const { nodes, view, coverageOf } = options;
  const routes = routesOf(options.api, nodes);
  const base = baseOf(options.baseUrl ?? "");
  const online = options.online ?? navigatorOnline;
  /** The cookie at the time of an answer; read only when a response is synthesised. */
  const cookie: Effect.Effect<string | undefined> =
    options.cookie === undefined
      ? Effect.succeed(undefined)
      : Effect.catch(options.cookie, () => Effect.succeed(undefined));
  // One writer per link prefix the routes imply (one, for an api mounted once).
  const writers = new Map<string, ReplicaDocuments.ReplicaDocuments>();
  for (const route of routes) {
    const prefix = options.prefix ?? route.prefix;
    if (!writers.has(prefix)) {
      writers.set(
        prefix,
        ReplicaDocuments.make({
          nodes,
          prefix,
          ...(options.resources === undefined ? {} : { resources: options.resources }),
        })
      );
    }
  }

  const candidateOf = (request: Request): Candidate | undefined => {
    if (request.method !== "GET" || !acceptsJsonApi(request.headers.get("accept"))) {
      return undefined;
    }
    const url = new URL(request.url);
    const path = pathUnder(base, url);
    if (path === undefined) return undefined;
    const segments = Convention.segmentsOf(path);
    const route = routes.find((candidate) => matchesTemplate(candidate, segments));
    return route === undefined ? undefined : { route, url };
  };

  /** Rules 1 to 4 for every read the request needs, judged over the request's root rows: covered by the ledger, or not the façade's to answer. */
  const covered = (
    reads: ReadonlyArray<Query.Read>,
    snapshot: Coverage.Snapshot
  ): Effect.Effect<boolean> =>
    Effect.forEach(reads, (read) => coverageOf(read, { snapshot })).pipe(
      Effect.map((verdicts) => verdicts.every((verdict) => verdict._tag === "Covered"))
    );

  /** The replica with the request's root window answered from `rows`: the rows coverage judged, not a second read. */
  const pinned = (
    base: ClientView.Reader,
    root: Subset.Subset,
    rows: ReadonlyArray<ClientEngine.LocalRow>
  ): ClientView.Reader => ({
    query: (subset) =>
      Subset.hash(subset) === Subset.hash(root) ? Effect.succeed(rows) : base.query(subset),
    observe: base.observe,
  });

  /** A rejection as an outcome, with the cookie read for the response it may carry. */
  const rejected = (error: QueryError): Effect.Effect<never, Outcome> =>
    Effect.flatMap(cookie, (served) => Effect.fail(queryFailure(error, served)));

  const answer = ({ route, url }: Candidate) =>
    Effect.gen(function* () {
      const docs = writers.get(options.prefix ?? route.prefix)!;
      const parsed = yield* JsonApiQuery.parseRead(nodes, url).pipe(Effect.catch(rejected));
      // A collection no bound resource declares: the server rules on it.
      const needed = yield* docs.toCover(parsed.read).pipe(Effect.mapError(() => forward));
      // The request's root rows, read once: coverage is judged over them and the document is
      // written from them, so a pull between the two cannot add a root row whose edge windows
      // are not pulled yet (#426). A root that cannot be read is uncovered, as before.
      const root = yield* Query.tryPlan(nodes, parsed.read).pipe(Effect.mapError(() => forward));
      const rows = yield* view
        .query(root.root)
        .pipe(
          Effect.orElseSucceed((): ReadonlyArray<ClientEngine.LocalRow> | undefined => undefined)
        );
      if (rows === undefined || !(yield* covered(needed, { subset: root.root, rows }))) {
        if (online()) return yield* Effect.fail(forward);
        return yield* Effect.flatMap(cookie, (served) =>
          Effect.fail(respond(offlineResponse(served)))
        );
      }
      const replica = pinned(view, root.root, rows);
      const write: Effect.Effect<ReplicaDocuments.Document, QueryError> =
        parsed.id === undefined ? docs.collection(replica, parsed) : docs.data(replica, parsed);
      const document = yield* write.pipe(Effect.catch(rejected));
      // No such row in a faithful replica: the 404 is the endpoint's own.
      if (parsed.id !== undefined && document.data === null) return yield* Effect.fail(forward);
      return respondWith(200, document, yield* cookie);
    });

  const handle: FetchHandler["handle"] = (request) => {
    const candidate = candidateOf(request);
    if (candidate === undefined) return Effect.succeed(undefined);
    return answer(candidate).pipe(
      Effect.catch((outcome) =>
        Effect.succeed(outcome._tag === "Forward" ? undefined : outcome.response)
      )
    );
  };

  return {
    matches: (request) => candidateOf(request) !== undefined,
    handle,
    offline: Effect.map(cookie, offlineResponse),
  };
};
