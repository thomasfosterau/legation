/**
 * Platform
 *
 * The two Workers runtime globals this package touches. Workers-types is
 * imported **module-style** everywhere (ambient inclusion would leak
 * Workers globals into every sibling package's compile), so the globals
 * that only exist at runtime are narrowed here, once, with the platform
 * contract spelled out.
 */

import type { WebSocket } from "@cloudflare/workers-types";

/** A socket the hibernation API accepts and the room sends poke frames on. */
export type RoomSocket = Pick<WebSocket, "send">;

/** `new WebSocketPair()` — the Workers global (absent from lib.dom). */
export const webSocketPair = (): { readonly client: unknown; readonly server: unknown } => {
  const pair = new (
    globalThis as typeof globalThis & {
      WebSocketPair: new () => Record<0 | 1, unknown>;
    }
  ).WebSocketPair();
  return { client: pair[0], server: pair[1] };
};

/** A 101 upgrade response carrying the client socket (Workers extension). */
export const upgradeResponse = (client: unknown): Response =>
  new Response(null, { status: 101, webSocket: client } as ResponseInit);
