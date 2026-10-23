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
 * 6. **Writes** (ADR-0030, with {@link Options.mutate} set). A `POST` /
 *    `PATCH` / `DELETE` on a reflected write route of a type the graph
 *    declares (and {@link Options.writes} allows) is forwarded unchanged
 *    while online and unasked; offline, after a forward that rejected at the
 *    transport, or on `Prefer: respond-async`, it is decoded structurally
 *    (`FacadeWrites`), mapped to a mutation by the intent mapping (default:
 *    the graph-derived CRUD mutations, `CrudMutation`), journaled, and
 *    answered with a `202 Accepted` **write receipt**: the resource as
 *    journaled, read back through the one writer, `meta.legation.status:
 *    "pending"` and a `Location` naming the mutation status URL. Never `201`,
 *    `200` or `204`: those are the server's words for "applied". A write it
 *    cannot journal is forwarded online; offline it gets ADR-0030 §3's error
 *    documents: `400 invalid_document`, `409 type_mismatch` / `id_mismatch`
 *    or `422 unsupported_relationship` for a malformed body, and the `503`
 *    `offline` document otherwise, with `client_id_required` appended for a
 *    create without an id and `not_journalable` for a mutation the engine
 *    refuses. Attribute values are never the façade's to refuse.
 *
 * 7. **The mutation status URL** (ADR-0030 §2, with
 *    {@link Options.mutationStates} set): `GET {prefix}/_legation/mutations/{id}`
 *    beside every reflected prefix is answered from the engine's
 *    mutation-state map and never forwarded (`MutationStatus`): `200` with
 *    the mutation's phase, `404 unknown_mutation` for an id the map does not
 *    hold, `Prefer: wait=N` holding a pending answer up to
 *    {@link Options.maxWait}.
 *
 * What it never does: register a subscription because a request arrived,
 * journal a write online unless asked, or rewrite a request it forwards. A single-resource
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

import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { MEDIA_TYPE, type Resource } from "@thomasfosterau/effect-jsonapi";
import { Query } from "@thomasfosterau/legation-effect";
import type {
  CrudMutation,
  MutatorError,
  Node,
  QueryError,
  StoreError,
} from "@thomasfosterau/legation-effect";
import type {
  ClientEngine,
  ClientView,
  Coverage,
  MutationState,
} from "@thomasfosterau/legation-effect/internal";
import { Subset } from "@thomasfosterau/legation-effect/internal";
import * as Convention from "./Convention.js";
import * as FacadeWrites from "./FacadeWrites.js";
import * as JsonApiQuery from "./JsonApiQuery.js";
import * as MutationStatus from "./MutationStatus.js";
import * as ReplicaDocuments from "./ReplicaDocuments.js";
import type { Write } from "./JsonApiBackend.js";
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
  /**
   * The engine's journal seam for façade writes (ADR-0030 §5): in a worker,
   * `host.engine.mutateWithAck`. Absent, the façade intercepts no write: a
   * `POST` / `PATCH` / `DELETE` is never its business, as before ADR-0030.
   */
  readonly mutate?: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<ClientEngine.MutationHandle, MutatorError | StoreError>;
  /**
   * The intent mapping: a decoded write to the mutation the engine journals,
   * or `undefined` when it is not interceptable. Default: the graph-derived
   * CRUD mutations (`CrudMutation`, `FacadeWrites.graphIntentOf`), which the
   * engine's registry must then carry (`CrudMutation.entries(nodes)`), with a
   * server handler under each name.
   */
  readonly intentOf?: FacadeWrites.IntentOf;
  /**
   * Which reflected write routes may be intercepted, per type: owning this
   * declaration means owning the server's side of it (handlers under the
   * mutation names, creates that honour the client id, ADR-0030 §4).
   * Default: every reflected `create` / `update` / `delete` route of a type
   * the graph declares.
   */
  readonly writes?: CrudMutation.Writes;
  /**
   * The pull to signal after a write forwarded online succeeded
   * ({@link FetchHandler.forwarded}): in a worker, `host.engine.pull`. Its
   * failure is ignored; the sync loop pulls again on its own.
   */
  readonly pull?: Effect.Effect<unknown, unknown>;
  /**
   * The engine's mutation-state map (`engine.mutationStates`, #116), which
   * the mutation status URL `{prefix}/_legation/mutations/{mutationId}` is
   * answered from (ADR-0030 §2, `MutationStatus`). Absent, that route is not
   * the façade's. A worker composing the façade should raise the engine's
   * `mutationStateRetention.maxTerminal`, so a settled phase outlives a busy
   * session.
   */
  readonly mutationStates?: Stream.Stream<MutationState.MutationStateMap>;
  /** The cap on a status request's `Prefer: wait`; default 30 seconds. */
  readonly maxWait?: Duration.Input;
}

/** The built façade. */
export interface FetchHandler {
  /**
   * Whether a request is the façade's business: a `GET` accepting
   * `application/vnd.api+json` on a reflected read route under `baseUrl`,
   * or — with {@link Options.mutate} set — a `POST` / `PATCH` / `DELETE` on a
   * reflected write route the façade may intercept, accepting the media
   * type and (for `POST` / `PATCH`) sending it without the atomic extension
   * (ADR-0030 §3). A worker asks it for every method, clones a matched
   * write before forwarding it, and turns a forward that rejected at the
   * transport into {@link FetchHandler.offline}.
   */
  readonly matches: (request: Request) => boolean;
  /**
   * The façade's answer: a document (200), the codec's 400 for a URL the
   * grammar rejects, the 503 `offline` document for an uncovered request
   * while offline, a `202` write receipt for a write it journals (offline,
   * or on `Prefer: respond-async`) — or `undefined` when the request is not
   * the façade's business, is uncovered and online, or is a write to
   * forward, for the caller to forward unchanged. A write's body is read
   * from a clone, so the request itself can still be forwarded. A store
   * failure while reading the replica is a defect, as `Query.run` treats it.
   */
  readonly handle: (request: Request) => Effect.Effect<Response | undefined>;
  /**
   * What a worker answers when the forward of a request {@link matches} held
   * for rejected at the transport, the other half of ADR-0029 §4's
   * definition: for a write, the request is journaled and answered with a
   * `202` receipt (pass the clone taken before forwarding, whose body is
   * unread); otherwise, or when the write cannot be journaled, the 503
   * `offline` response with the replica's current cookie.
   */
  readonly offline: (request: Request) => Effect.Effect<Response>;
  /**
   * Tell the façade what a forwarded request came back with: after a `2xx`
   * to a write it {@link matches}, it signals {@link Options.pull} so a
   * covered read soon shows the server's row (ADR-0030 §3). A worker runs it
   * in the background (`event.waitUntil`); it never fails.
   */
  readonly forwarded: (request: Request, response: Response) => Effect.Effect<void>;
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
const respondWith = (
  status: number,
  body: unknown,
  cookie: string | undefined,
  headers: Readonly<Record<string, string>> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "content-type": MEDIA_TYPE,
      "cache-control": "no-store",
      [servedAtHeader]: cookie ?? "",
    },
  });

/**
 * Why a write candidate was not journaled: its body was refused
 * structurally (`FacadeWrites.Refusal`), the engine refused the mutation (a
 * `MutatorError`: the intent mapping named a mutator it does not register),
 * or there is no mutation to journal (the intent mapping declined it, or the
 * store failed).
 */
type Unjournaled =
  | { readonly _tag: "Refused"; readonly refusal: FacadeWrites.Refusal }
  | { readonly _tag: "NotJournalable"; readonly detail: string }
  | { readonly _tag: "Unmapped" };

/** One error object of a façade-synthesised write error, `source.pointer` when it names one. */
const errorObject = (refusal: {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly pointer?: string;
}): RestHandlers.ErrorDocument["errors"][number] => {
  const error = {
    status: String(refusal.status),
    code: refusal.code,
    title: refusal.title,
    detail: refusal.detail,
  };
  return refusal.pointer === undefined ? error : { ...error, source: { pointer: refusal.pointer } };
};

/** The 503 `offline` document with a second error object saying why the write was not journaled. */
const offlineWith = (reason: Parameters<typeof errorObject>[0]): RestHandlers.ErrorDocument => ({
  errors: [...offlineDocument.errors, errorObject(reason)],
});

/**
 * The offline answer to a write it could not journal (ADR-0030 §3): a
 * structural refusal is its own `400` / `409` / `422` document — the statuses
 * JSON:API prescribes for the same faults, so no divergence from the server —
 * except a create without a client id, which is the `503` `offline` document
 * with `client_id_required` appended; an engine refusal is `503` `offline`
 * with `not_journalable`; anything else the plain `503` `offline`.
 */
const unjournaledDocument = (
  failure: Unjournaled
): readonly [status: number, document: RestHandlers.ErrorDocument] =>
  Match.valueTags(failure, {
    Refused: ({ refusal }): readonly [number, RestHandlers.ErrorDocument] =>
      refusal.status === 503
        ? [503, offlineWith(refusal)]
        : [refusal.status, { errors: [errorObject(refusal)] }],
    NotJournalable: ({ detail }): readonly [number, RestHandlers.ErrorDocument] => [
      503,
      offlineWith({ status: 503, code: "not_journalable", title: "Not journalable", detail }),
    ],
    Unmapped: (): readonly [number, RestHandlers.ErrorDocument] => [503, offlineDocument],
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
  return { type, segments, prefix: Arr.isReadonlyArrayEmpty(prefix) ? "" : `/${prefix.join("/")}` };
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

/** One reflected write route the façade may intercept (ADR-0030 §3). */
interface WriteRoute extends Route {
  readonly operation: "create" | "update" | "delete";
  /** The node the route writes. */
  readonly node: Node.AnyNode;
  /** The method it answers: `POST`, `PATCH` or `DELETE` (a `PUT` update is never intercepted). */
  readonly method: string;
}

const writeMethods = { create: "POST", update: "PATCH", delete: "DELETE" } as const;

/** The write routes of the api whose type the graph declares and `writes` allows. */
const writeRoutesOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  nodes: Node.NodeRegistry,
  writes: CrudMutation.Writes | undefined
): ReadonlyArray<WriteRoute> =>
  Arr.flatMap([...Convention.reflectResources(api).values()], (resource) => {
    const node = nodes.nodes.get(resource.type);
    if (node === undefined) return [];
    return Arr.filterMap(["create", "update", "delete"] as const, (operation) => {
      const endpoint = resource[operation];
      const method = writeMethods[operation];
      const allowed = writes === undefined || (writes[resource.type] ?? []).includes(operation);
      return endpoint === undefined || endpoint.method.toUpperCase() !== method || !allowed
        ? Result.failVoid
        : Result.succeed({
            ...routeOf(resource.type, endpoint.path, operation !== "create"),
            operation,
            node,
            method,
          });
    });
  });

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
  header
    .split(",")
    .some((part) => (part.trim().split(";")[0] ?? "").trim().toLowerCase() === MEDIA_TYPE);

/**
 * Whether a `Content-Type` is the JSON:API media type without the atomic
 * extension: an `ext` parameter naming atomic marks the operations endpoint,
 * never a façade write (ADR-0030 §5).
 */
const sendsJsonApi = (header: string | null): boolean => {
  if (header === null) return false;
  const [type = "", ...parameters] = header.split(";");
  if (type.trim().toLowerCase() !== MEDIA_TYPE) return false;
  return !parameters.some((parameter) => {
    const [name = "", value = ""] = parameter.split("=");
    return name.trim().toLowerCase() === "ext" && value.toLowerCase().includes("atomic");
  });
};

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
  | { readonly _tag: "Forward" }
  | { readonly _tag: "Respond"; readonly response: Response };

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
  const mutate = options.mutate;
  const writeRoutes = mutate === undefined ? [] : writeRoutesOf(options.api, nodes, options.writes);
  const intentOf = options.intentOf ?? FacadeWrites.graphIntentOf(nodes);
  const base = baseOf(options.baseUrl ?? "");
  const online = options.online ?? navigatorOnline;
  /** The cookie at the time of an answer; read only when a response is synthesised. */
  const cookie: Effect.Effect<string | undefined> =
    options.cookie === undefined
      ? Effect.succeed(undefined)
      : Effect.catch(options.cookie, () => Effect.succeed(undefined));
  // One writer per link prefix the routes imply (one, for an api mounted once).
  const writers = new Map<string, ReplicaDocuments.ReplicaDocuments>();
  /** The writer for a link prefix: one per prefix, built when a route first needs it. */
  const writerFor = (prefix: string): ReplicaDocuments.ReplicaDocuments => {
    const existing = writers.get(prefix);
    if (existing !== undefined) return existing;
    const made = ReplicaDocuments.make({
      nodes,
      prefix,
      ...(options.resources === undefined ? {} : { resources: options.resources }),
    });
    writers.set(prefix, made);
    return made;
  };

  for (const route of routes) writerFor(options.prefix ?? route.prefix);

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
      const docs = writers.get(options.prefix ?? route.prefix);
      // Every route's prefix has a writer (built above); an unknown one is the server's to answer.
      if (docs === undefined) return yield* Effect.fail(forward);
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

  const readHandle = (request: Request): Effect.Effect<Response | undefined> => {
    const candidate = candidateOf(request);
    if (candidate === undefined) return Effect.succeed(undefined);
    return answer(candidate).pipe(
      Effect.catchTags({
        Forward: () => Effect.succeed(undefined),
        Respond: (outcome) => Effect.succeed(outcome.response),
      })
    );
  };

  // ─── Writes (ADR-0030) ─────────────────────────────────────────────────────

  /** A write the façade may intercept: the route, its target, and where its api is mounted. */
  interface WriteCandidate {
    readonly route: WriteRoute;
    readonly target: FacadeWrites.Target;
  }

  const writeCandidateOf = (request: Request): WriteCandidate | undefined => {
    const method = request.method.toUpperCase();
    if (!acceptsJsonApi(request.headers.get("accept"))) return undefined;
    if (method !== "DELETE" && !sendsJsonApi(request.headers.get("content-type"))) {
      return undefined;
    }
    const path = pathUnder(base, new URL(request.url));
    if (path === undefined) return undefined;
    const segments = Convention.segmentsOf(path);
    const route = writeRoutes.find(
      (candidate) => candidate.method === method && matchesTemplate(candidate, segments)
    );
    if (route === undefined) return undefined;
    const target: FacadeWrites.Target =
      route.operation === "create"
        ? { operation: "create", type: route.type }
        : {
            operation: route.operation,
            type: route.type,
            id: decodeURIComponent(segments.at(-1) ?? ""),
          };
    return { route, target };
  };

  /** The mutation status URL of a journaled mutation: beside the api it belongs to (ADR-0030 §2). */
  const statusUrl = (route: Route, mutationId: number): string =>
    `${base.origin ?? ""}${base.path}${route.prefix}/_legation/mutations/${mutationId}`;

  /**
   * The receipt's `data`: the resource read back through the one writer
   * after journaling (ADR-0030 §1), or — when the replica does not hold the
   * row (a patch of a row it never pulled) — the request's own members.
   */
  const receiptData = ({ route }: WriteCandidate, write: Write): Effect.Effect<unknown> => {
    const prefix = options.prefix ?? route.prefix;
    const docs = writerFor(prefix);
    const sent = {
      type: write.type,
      id: write.id,
      attributes: write.attributes ?? {},
    };
    return docs.fromUrl(view, `${prefix}/${write.type}/${encodeURIComponent(write.id)}`).pipe(
      Effect.map((document) =>
        "data" in document && document.data !== null && !Array.isArray(document.data)
          ? document.data
          : sent
      ),
      Effect.orElseSucceed(() => sent)
    );
  };

  /**
   * Journal a write and answer its `202` receipt, or fail with `undefined`
   * when it cannot be journaled (the caller forwards it online, or answers
   * offline). The body is read from a clone.
   */
  const journal = (
    request: Request,
    candidate: WriteCandidate,
    preferences: FacadeWrites.Preferences
  ): Effect.Effect<Response, Unjournaled> =>
    Effect.gen(function* () {
      const body = Effect.tryPromise(() => request.clone().text());
      const write = yield* FacadeWrites.decodeWrite(
        candidate.route.node,
        candidate.target,
        body
      ).pipe(Effect.mapError((refusal): Unjournaled => ({ _tag: "Refused", refusal })));
      const intent = intentOf(write);
      if (intent === undefined || mutate === undefined) {
        return yield* Effect.fail<Unjournaled>({ _tag: "Unmapped" });
      }
      const handle = yield* mutate(intent.mutator, intent.args).pipe(
        Effect.mapError((error): Unjournaled =>
          P.isTagged(error, "MutatorError")
            ? { _tag: "NotJournalable", detail: error.message }
            : { _tag: "Unmapped" }
        )
      );
      const location = statusUrl(candidate.route, handle.mutationId);
      const meta = {
        legation: { status: "pending", mutationId: handle.mutationId, mutation: location },
      };
      const document =
        write.operation === "delete"
          ? { meta }
          : { data: yield* receiptData(candidate, write), meta };
      const headers = preferences.respondAsync
        ? { location, "preference-applied": "respond-async" }
        : { location };
      return respondWith(202, document, yield* cookie, headers);
    });

  const offlineNow: Effect.Effect<Response> = Effect.map(cookie, offlineResponse);

  /** The offline answer to a write it could not journal: ADR-0030 §3's error documents. */
  const unjournaled = (failure: Unjournaled): Effect.Effect<Response> =>
    Effect.map(cookie, (served) => {
      const [status, document] = unjournaledDocument(failure);
      return respondWith(status, document, served);
    });

  /** ADR-0030 §3's decision table for a write candidate, offline meaning `navigator.onLine` false. */
  const writeHandle = (
    request: Request,
    candidate: WriteCandidate
  ): Effect.Effect<Response | undefined> => {
    const preferences = FacadeWrites.preferencesOf(request.headers);
    const reachable = online();
    if (preferences.strict) return reachable ? Effect.succeed(undefined) : offlineNow;
    if (reachable && !preferences.respondAsync) return Effect.succeed(undefined);
    return journal(request, candidate, preferences).pipe(
      Effect.catch((failure) => (reachable ? Effect.succeed(undefined) : unjournaled(failure)))
    );
  };

  // ─── The mutation status URL (ADR-0030 §2) ─────────────────────────────────

  const mutationStates = options.mutationStates;
  const maxWait = Duration.fromInputUnsafe(options.maxWait ?? MutationStatus.defaultMaxWait);
  /** Every prefix the api's reflected routes sit under: the status route sits beside each. */
  const prefixes = Arr.dedupe(Arr.map([...routes, ...writeRoutes], (route) => route.prefix));

  /** A status request: the route prefix it names and the id segment, or `undefined`. */
  const statusCandidateOf = (
    request: Request
  ): { readonly prefix: string; readonly id: string } | undefined => {
    if (mutationStates === undefined || request.method !== "GET") return undefined;
    if (!acceptsJsonApi(request.headers.get("accept"))) return undefined;
    const path = pathUnder(base, new URL(request.url));
    if (path === undefined) return undefined;
    const segments = Convention.segmentsOf(path);
    const [id = "", mutations = "", legation = ""] = segments.toReversed();
    if (legation !== MutationStatus.segment || mutations !== "mutations") return undefined;
    const prefix = segments.slice(0, -3);
    const joined = Arr.isReadonlyArrayEmpty(prefix) ? "" : `/${prefix.join("/")}`;
    return prefixes.includes(joined) ? { prefix: joined, id: decodeURIComponent(id) } : undefined;
  };

  const statusHandle = (
    request: Request,
    states: Stream.Stream<MutationState.MutationStateMap>,
    candidate: { readonly prefix: string; readonly id: string }
  ): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const links = `${base.origin ?? ""}${base.path}${candidate.prefix}`;
      const mutationId = MutationStatus.parseId(candidate.id);
      if (Option.isNone(mutationId)) {
        return respondWith(404, MutationStatus.unknownDocument(candidate.id), yield* cookie);
      }
      const now = yield* MutationStatus.current(states, mutationId.value);
      const asked = FacadeWrites.preferencesOf(request.headers).wait;
      const wait =
        asked === undefined || Option.isNone(now) || now.value.phase !== "pending"
          ? undefined
          : Duration.min(Duration.seconds(asked), maxWait);
      const state =
        wait === undefined ? now : yield* MutationStatus.settled(states, mutationId.value, wait);
      const served = yield* cookie;
      if (Option.isNone(state)) {
        return respondWith(404, MutationStatus.unknownDocument(candidate.id), served);
      }
      const document = MutationStatus.document(nodes, links, state.value);
      return wait === undefined
        ? respondWith(200, document, served)
        : respondWith(200, document, served, {
            "preference-applied": `wait=${Math.floor(Duration.toSeconds(wait))}`,
          });
    });

  const handle: FetchHandler["handle"] = (request) => {
    const status = statusCandidateOf(request);
    if (status !== undefined && mutationStates !== undefined) {
      return statusHandle(request, mutationStates, status);
    }
    const write = writeCandidateOf(request);
    return write === undefined ? readHandle(request) : writeHandle(request, write);
  };

  const offline: FetchHandler["offline"] = (request) => {
    const write = writeCandidateOf(request);
    if (write === undefined) return offlineNow;
    const preferences = FacadeWrites.preferencesOf(request.headers);
    if (preferences.strict) return offlineNow;
    return journal(request, write, preferences).pipe(Effect.catch(unjournaled));
  };

  const forwarded: FetchHandler["forwarded"] = (request, response) =>
    options.pull !== undefined &&
    response.status >= 200 &&
    response.status < 300 &&
    writeCandidateOf(request) !== undefined
      ? Effect.ignore(options.pull)
      : Effect.void;

  return {
    matches: (request) =>
      candidateOf(request) !== undefined ||
      writeCandidateOf(request) !== undefined ||
      statusCandidateOf(request) !== undefined,
    handle,
    offline,
    forwarded,
  };
};
