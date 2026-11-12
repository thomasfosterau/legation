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
 *
 * Anonymous callers get a 401 unless {@link RouterConfig.anonymousRoomOf}
 * routes them. Readers of public collections then share rooms named under
 * {@link anonymousRoomPrefix}, which no identified caller is routed to, and
 * {@link shardByClientGroup} spreads them over a fixed number of rooms by
 * their client-group cookie, so one Durable Object is not their ceiling.
 */

import type * as Workers from "@alchemy.run/cloudflare/Workers";
import * as Effect from "effect/Effect";
import type { HttpServerError } from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { Hash } from "@thomasfosterau/legation/internal";
import type * as Room from "./Room.js";
import { routeOf } from "./RoomProtocol.js";

/** Configuration for {@link routeSync}. */
export interface RouterConfig<R = never> {
  /** The room namespace (`yield* LegationRoom` at the Worker's init). */
  readonly rooms: Workers.DurableObject<Room.RoomObject>;
  /**
   * Resolve the caller's room id — the per-user identity, typically from
   * the verified session. `Option.none()` is an anonymous caller: a 401,
   * unless {@link RouterConfig.anonymousRoomOf} routes it to an anonymous room.
   */
  readonly roomIdOf: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<Option.Option<string>, never, R>;
  /** The base path the sync routes hang off. Default `/sync`. */
  readonly basePath?: string | undefined;
  /**
   * Route a caller {@link RouterConfig.roomIdOf} left anonymous: the key of
   * the anonymous room it shares (e.g. {@link shardByClientGroup}), or
   * `Option.none()` for a 401. The room is named `anonymousRoomPrefix + key`,
   * so an anonymous caller never reaches a user's room. Unset, every
   * anonymous caller gets a 401.
   */
  readonly anonymousRoomOf?: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<Option.Option<string>, never, R>;
}

/**
 * The prefix of every anonymous room's name. `roomIdOf` must never answer an
 * id that starts with it: the router answers such a request with a 500
 * rather than route an identified caller into a shared anonymous room.
 */
export const anonymousRoomPrefix = "legation:anonymous:";

/** Options for {@link shardByClientGroup}. */
export interface ClientGroupShardOptions {
  /** How many anonymous rooms to spread readers over: a positive integer (rounded down, at least 1). */
  readonly shards: number;
  /** The client-group cookie's name. Default `"legation-client-group"`, as the SvelteKit adapter sets it. */
  readonly cookie?: string;
}

/**
 * Shards anonymous callers over `shards` rooms by a hash of their client-group cookie, for
 * {@link RouterConfig.anonymousRoomOf}.
 *
 * A client group always lands in the same room, so its CVRs stay in one place; a caller with no
 * cookie gets `Option.none()` (a 401). The hash is FNV-1a over the cookie (`Hash.contentHash`),
 * stable across deploys, so changing `shards` moves most groups to another room, where their next
 * pull is a reset. The cookie is not a credential: a caller can pick its shard, never a user's room.
 */
export const shardByClientGroup = (
  options: ClientGroupShardOptions
): ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<string>>) => {
  const shards = Math.max(1, Math.floor(options.shards));
  const cookie = options.cookie ?? "legation-client-group";
  return (request) =>
    Effect.succeed(
      Option.map(R.get(request.cookies, cookie), (group) =>
        String(Number.parseInt(Hash.contentHash(group), 16) % shards)
      )
    );
};

/**
 * Route one request: `Option.none()` for a path outside the base, a 404 for an
 * unknown route under it, a 401 for an anonymous caller that
 * {@link RouterConfig.anonymousRoomOf} does not route, otherwise the room's own
 * response.
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

    const identified = yield* config.roomIdOf(request);
    if (Option.isSome(identified)) {
      if (identified.value.startsWith(anonymousRoomPrefix)) {
        yield* Effect.logError(
          `routeSync: roomIdOf answered "${identified.value}", which is reserved for anonymous rooms`
        );
        return Option.some(HttpServerResponse.text("internal error", { status: 500 }));
      }
      return Option.some(yield* config.rooms.getByName(identified.value).fetch(request));
    }
    const anonymous =
      config.anonymousRoomOf === undefined
        ? Option.none<string>()
        : yield* config.anonymousRoomOf(request);
    if (Option.isNone(anonymous)) {
      return Option.some(HttpServerResponse.text("unauthorized", { status: 401 }));
    }
    return Option.some(
      yield* config.rooms.getByName(`${anonymousRoomPrefix}${anonymous.value}`).fetch(request)
    );
  });
