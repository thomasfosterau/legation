/**
 * Convention
 *
 * Convention-first discovery of a JSON:API resource surface from an app's
 * Effect `HttpApi` (the happy path: "bring a JSON:API api, get sync"). We
 * reflect the api's endpoints and classify each one by HTTP method + path
 * into a JSON:API role, so no per-endpoint annotation is required:
 *
 * | method  | path shape      | role     |
 * | ------- | --------------- | -------- |
 * | GET     | `/{type}`       | list     |
 * | GET     | `/{type}/:id`   | getOne   |
 * | POST    | `/{type}`       | create   |
 * | PATCH   | `/{type}/:id`   | update   |
 * | PUT     | `/{type}/:id`   | update   |
 * | DELETE  | `/{type}/:id`   | delete   |
 *
 * The resource `type` (the collection name) is the last static path segment
 * (the segment before a trailing `:id` param, or the final segment). Any
 * prefix (`/api`, version segments) is ignored. Endpoints that don't fit the
 * table — nested routes, RPCs, custom actions — are simply not part of the
 * derived CRUD surface; the app can still call them directly.
 *
 * One endpoint is recognised structurally rather than by path: an atomic
 * operations endpoint (the JSON:API Atomic Operations extension, e.g.
 * effect-jsonapi's `Endpoint.operations`, conventionally `POST /operations`)
 * is any endpoint whose request payload is an `atomic:operations` document.
 * By path shape alone it would read as `create` on a phantom `operations`
 * resource, so `reflectResources` skips it and `reflectAtomic` reports it
 * instead — the backend then pushes a whole batch as one request.
 */

import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type * as SchemaAST from "effect/SchemaAST";
import * as Str from "effect/String";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";

/** A JSON:API role a CRUD endpoint plays for one resource type. */
export type Operation = "list" | "getOne" | "create" | "update" | "delete";

/** A reflected endpoint we can address on the app's HttpApi. */
export interface EndpointRef {
  readonly groupId: string;
  readonly name: string;
  readonly method: string;
  /** Route template as declared, e.g. `/todos/:id`. */
  readonly path: string;
}

/** The CRUD endpoints discovered for one resource type (collection); `None` for a role the api does not serve. */
export interface ResourceEndpoints {
  readonly type: string;
  readonly list: Option.Option<EndpointRef>;
  readonly getOne: Option.Option<EndpointRef>;
  readonly create: Option.Option<EndpointRef>;
  readonly update: Option.Option<EndpointRef>;
  readonly delete: Option.Option<EndpointRef>;
}

/** The endpoints of a type that serves none yet: every role `None`. */
const noEndpoints = (type: string): ResourceEndpoints => ({
  type,
  list: Option.none(),
  getOne: Option.none(),
  create: Option.none(),
  update: Option.none(),
  delete: Option.none(),
});

/** Resource endpoints keyed by type (collection name). */
export type ResourceMap = ReadonlyMap<string, ResourceEndpoints>;

/** A route template's segments, empty ones dropped (`/todos/:id` is `["todos", ":id"]`). */
export const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => Str.isNonEmpty(segment));

/** Whether a template segment is a path parameter (`:id`). */
export const isParam = (segment: string): boolean => segment.startsWith(":");

/** Map an HTTP method + whether the route has a trailing id to a CRUD role. */
const roleOf = (method: string, hasId: boolean): Option.Option<Operation> =>
  Match.value(method.toUpperCase()).pipe(
    Match.withReturnType<Option.Option<Operation>>(),
    Match.when("GET", () => Option.some(hasId ? "getOne" : "list")),
    Match.when("POST", () => (hasId ? Option.none() : Option.some("create"))),
    Match.whenOr("PATCH", "PUT", () => (hasId ? Option.some("update") : Option.none())),
    Match.when("DELETE", () => (hasId ? Option.some("delete") : Option.none())),
    Match.orElse(() => Option.none())
  );

/**
 * Classify a (method, path) into a resource type + role, or `None` if
 * it isn't a conventional JSON:API CRUD route — `/{type}` or `/{type}/:id`,
 * where the type is a static segment and the only param is a trailing id
 * (nested routes like `/todos/:id/comments` are not CRUD on a single type).
 */
export const classify = (
  method: string,
  path: string
): Option.Option<{ readonly type: string; readonly operation: Operation }> => {
  const segments = segmentsOf(path);
  const last = segments.at(-1);
  if (last === undefined) return Option.none();

  const hasId = isParam(last);
  const type = hasId ? segments[segments.length - 2] : last;
  if (type === undefined || isParam(type)) return Option.none();
  const params = segments.filter(isParam);
  if (params.length > 1 || (params.length === 1 && !hasId)) return Option.none();

  return Option.map(roleOf(method, hasId), (operation) => ({ type, operation }));
};

/** The top-level member that makes a request an atomic operations document. */
const ATOMIC_OPERATIONS_MEMBER = "atomic:operations";

/** Depth bound for walking a payload schema's unions and suspensions. */
const MEMBER_WALK_DEPTH = 8;

/**
 * Whether a schema is (or, through unions and suspensions, may be) an object
 * with a top-level `atomic:operations` member.
 */
const hasAtomicMember = (ast: SchemaAST.AST, depth = 0): boolean => {
  if (depth > MEMBER_WALK_DEPTH) return false;
  return Match.value(ast).pipe(
    Match.tag("Objects", (objects) =>
      objects.propertySignatures.some((property) => property.name === ATOMIC_OPERATIONS_MEMBER)
    ),
    Match.tag("Union", (union) => union.types.some((member) => hasAtomicMember(member, depth + 1))),
    Match.tag("Suspend", (suspend) => hasAtomicMember(suspend.thunk(), depth + 1)),
    Match.orElse(() => false)
  );
};

/**
 * Whether an endpoint takes an `atomic:operations` request document: some
 * payload schema (any content type) is an object with a top-level
 * `atomic:operations` member, possibly one arm of a union. This is what
 * makes an endpoint the atomic operations endpoint — not its path, which is
 * configurable.
 */
export const isAtomicEndpoint = (endpoint: HttpApiEndpoint.Top): boolean =>
  Iterable.some(endpoint.payload.values(), ({ schemas }) =>
    Iterable.some(schemas, (schema) => hasAtomicMember(schema.ast))
  );

const refOf = (group: HttpApiGroup.Top, endpoint: HttpApiEndpoint.Top): EndpointRef => ({
  groupId: group.identifier,
  name: endpoint.identifier,
  method: endpoint.method,
  path: endpoint.path,
});

/**
 * Reflect an `HttpApi` into its JSON:API resource surface. The first endpoint
 * matching each (type, role) wins; later duplicates are ignored. An atomic
 * operations endpoint is never a resource (see `reflectAtomic`).
 */
export const reflectResources = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): ResourceMap => {
  const resources = new Map<string, ResourceEndpoints>();

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      if (isAtomicEndpoint(endpoint)) return;
      const role = classify(endpoint.method, endpoint.path);
      if (Option.isNone(role)) return;
      const { type, operation } = role.value;
      const existing = resources.get(type) ?? noEndpoints(type);
      if (Option.isSome(existing[operation])) return;
      resources.set(type, { ...existing, [operation]: Option.some(refOf(group, endpoint)) });
    },
  });

  return resources;
};

/**
 * Reflect an `HttpApi`'s atomic operations endpoint, if it declares one: the
 * first endpoint whose request payload is an `atomic:operations` document,
 * or `None`.
 * `JsonApiSync` uses it to push a batch as one all-or-nothing request.
 */
export const reflectAtomic = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): Option.Option<EndpointRef> => {
  let atomic = Option.none<EndpointRef>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      if (Option.isNone(atomic) && isAtomicEndpoint(endpoint)) {
        atomic = Option.some(refOf(group, endpoint));
      }
    },
  });
  return atomic;
};
