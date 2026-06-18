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
 */

import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

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

/** The CRUD endpoints discovered for one resource type (collection). */
export interface ResourceEndpoints {
  readonly type: string;
  readonly list?: EndpointRef;
  readonly getOne?: EndpointRef;
  readonly create?: EndpointRef;
  readonly update?: EndpointRef;
  readonly delete?: EndpointRef;
}

/** Resource endpoints keyed by type (collection name). */
export type ResourceMap = ReadonlyMap<string, ResourceEndpoints>;

const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment.length > 0);

const isParam = (segment: string): boolean => segment.startsWith(":");

/**
 * Classify a (method, path) into a resource type + role, or `undefined` if
 * it isn't a conventional JSON:API CRUD route.
 */
export const classify = (
  method: string,
  path: string
): { readonly type: string; readonly operation: Operation } | undefined => {
  const segments = segmentsOf(path);
  if (segments.length === 0) return undefined;

  const last = segments[segments.length - 1]!;
  const hasId = isParam(last);
  const type = hasId ? segments[segments.length - 2] : last;
  // A conventional route is `/{type}` or `/{type}/:id`: the type must be a
  // static segment, and the only param allowed is a trailing id (nested
  // routes like `/todos/:id/comments` are not CRUD on a single type).
  if (type === undefined || isParam(type)) return undefined;
  const params = segments.filter(isParam);
  if (params.length > 1 || (params.length === 1 && !hasId)) return undefined;

  switch (method.toUpperCase()) {
    case "GET":
      return { type, operation: hasId ? "getOne" : "list" };
    case "POST":
      return hasId ? undefined : { type, operation: "create" };
    case "PATCH":
    case "PUT":
      return hasId ? { type, operation: "update" } : undefined;
    case "DELETE":
      return hasId ? { type, operation: "delete" } : undefined;
    default:
      return undefined;
  }
};

/**
 * Reflect an `HttpApi` into its JSON:API resource surface. The first endpoint
 * matching each (type, role) wins; later duplicates are ignored.
 */
export const reflectResources = (api: HttpApi.HttpApi<string, HttpApiGroup.Any>): ResourceMap => {
  const resources = new Map<
    string,
    { type: string } & { -readonly [K in Operation]?: EndpointRef }
  >();

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => {
      const role = classify(endpoint.method, endpoint.path);
      if (role === undefined) return;
      const existing = resources.get(role.type) ?? { type: role.type };
      if (existing[role.operation] !== undefined) return;
      existing[role.operation] = {
        groupId: group.identifier,
        name: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
      };
      resources.set(role.type, existing);
    },
  });

  return resources;
};
