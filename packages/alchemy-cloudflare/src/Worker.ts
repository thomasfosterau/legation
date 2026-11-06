/**
 * Worker
 *
 * The stateless entry of the reference topology: a helper for an Alchemy
 * Worker's `fetch` that resolves the caller's identity to their room and
 * forwards the sync routes there, through the room namespace's stub
 * (`rooms.getByName(roomId).fetch(request)`, WebSocket upgrades included).
 * Everything else about the Worker — the REST/JSON:API baseline, auth, static
 * assets — is the app's; this helper claims only the sync base path and
 * answers `Option.none()` for everything else, so it composes inside any
 * `fetch`:
 *
 * ```ts
 * const rooms = yield* LegationRoom;
 * return {
 *   fetch: Effect.gen(function* () {
 *     const routed = yield* Worker.routeSync({ rooms, roomIdOf });
 *     return Option.isSome(routed) ? routed.value : yield* app;
 *   }),
 * };
 * ```
 *
 * The request reaches the room unchanged, base path included; the room
 * answers a route by the path's last segment (`RoomProtocol.routeOf`).
 */

import type * as Workers from "@alchemy.run/cloudflare/Workers";
import * as Effect from "effect/Effect";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type * as Room from "./Room.js";
import { routeOf } from "./RoomProtocol.js";

/** Configuration for {@link routeSync}. */
export interface RouterConfig<R = never> {
  /** The room namespace (`yield* LegationRoom` at the Worker's init). */
  readonly rooms: Workers.DurableObject<Room.RoomObject>;
  /**
   * Resolve the caller's room id — the per-user identity, typically from
   * the verified session. `undefined` rejects the request with 401:
   * anonymous callers never reach a room.
   */
  readonly roomIdOf: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<string | undefined, never, R>;
  /** The base path the sync routes hang off. Default `/sync`. */
  readonly basePath?: string | undefined;
}

/**
 * Route one request: `Option.none()` for a path outside the base, a 404 for an
 * unknown route under it, a 401 for an anonymous caller, otherwise the room's
 * own response.
 */
export const routeSync = <R = never>(
  config: RouterConfig<R>
): Effect.Effect<
  Option.Option<HttpServerResponse.HttpServerResponse>,
  HttpServerError,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const base = config.basePath ?? "/sync";
    const pathname = new URL(request.url, "https://worker").pathname;
    if (!pathname.startsWith(`${base}/`)) return Option.none();
    if (routeOf(pathname) === undefined || pathname.lastIndexOf("/") !== base.length) {
      return Option.some(HttpServerResponse.text("not found", { status: 404 }));
    }

    const roomId = yield* config.roomIdOf(request);
    if (roomId === undefined) {
      return Option.some(HttpServerResponse.text("unauthorized", { status: 401 }));
    }
    return Option.some(yield* config.rooms.getByName(roomId).fetch(request));
  });
