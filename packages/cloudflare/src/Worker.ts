/**
 * Worker
 *
 * The stateless entry of the reference topology: a fetch-handler helper
 * that resolves the caller's identity to their room and forwards the sync
 * routes there. Everything else about the Worker — the REST/JSON:API
 * baseline, auth, static assets — is the app's; this helper claims only
 * the sync base path and returns `undefined` for everything else, so it
 * composes inside any fetch handler:
 *
 * ```ts
 * export default {
 *   async fetch(request, env) {
 *     return (await routeSync(config)(request, env)) ?? app.fetch(request, env);
 *   },
 * };
 * ```
 */

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { routes } from "./RoomProtocol.js";

/** Configuration for {@link routeSync}. */
export interface RouterConfig<Env> {
  /** The room namespace binding (`env.ROOMS`). */
  readonly rooms: (env: Env) => DurableObjectNamespace;
  /**
   * Resolve the caller's room id — the per-user identity, typically from
   * the verified session. `undefined` rejects the request with 401:
   * anonymous callers never reach a room.
   */
  readonly roomIdOf: (
    request: Request,
    env: Env
  ) => string | undefined | Promise<string | undefined>;
  /** The base path the sync routes hang off. Default `/sync`. */
  readonly basePath?: string;
}

const ROOM_ROUTES: ReadonlySet<string> = new Set([
  routes.push,
  routes.pull,
  routes.read,
  routes.socket,
]);

/** Build the router. Returns `undefined` for paths outside the base. */
export const routeSync =
  <Env>(config: RouterConfig<Env>) =>
  async (request: Request, env: Env): Promise<Response | undefined> => {
    const base = config.basePath ?? "/sync";
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${base}/`)) return undefined;
    const route = url.pathname.slice(base.length);
    if (!ROOM_ROUTES.has(route)) return new Response("not found", { status: 404 });

    const roomId = await config.roomIdOf(request, env);
    if (roomId === undefined) return new Response("unauthorized", { status: 401 });

    const rooms = config.rooms(env);
    const stub = rooms.get(rooms.idFromName(roomId));
    const forwarded = new URL(request.url);
    forwarded.pathname = route;
    // Forward verbatim (WebSocket upgrades included — the stub carries them).
    return stub.fetch(forwarded.toString(), request as never) as unknown as Promise<Response>;
  };
