/**
 * RoomProtocol
 *
 * The room's wire format, chosen for WebSocket **hibernation**: requests
 * (push/pull/read) travel as stateless HTTP POST JSON — a hibernated room
 * wakes, answers, and may be evicted again — while the WebSocket carries
 * exactly one thing: contentless **poke** frames. No server-side session
 * state survives eviction, so none is kept.
 *
 * Shard ↔ room traffic is not on this wire: it is typed RPC on the Durable
 * Object stubs (`FanoutShard.ShardObject`, `Room.RoomObject`).
 */

import type * as Effect from "effect/Effect";
import type { ProtocolError } from "@thomasfosterau/legation";
import { Protocol } from "@thomasfosterau/legation/internal";

type Decoder<A> = (input: unknown) => Effect.Effect<A, ProtocolError>;

/**
 * The room's HTTP routes. A room answers a route by the request path's last
 * segment, so a request forwarded with its base path intact (`/sync/push`)
 * reaches the same route as `/push`.
 */
export const routes = {
  push: "/push",
  pull: "/pull",
  read: "/read",
  /** WebSocket upgrade: the poke channel. */
  socket: "/socket",
} as const;

/** One of the room's {@link routes}. */
export type Route = (typeof routes)[keyof typeof routes];

const ROUTES: ReadonlySet<string> = new Set([routes.push, routes.pull, routes.read, routes.socket]);

/**
 * The route a request path addresses: its last segment, when that names one of
 * the {@link routes}.
 */
export const routeOf = (pathname: string): Route | undefined => {
  const route = pathname.slice(pathname.lastIndexOf("/"));
  // SAFETY: `ROUTES` holds exactly the values of `routes`.
  return ROUTES.has(route) ? (route as Route) : undefined;
};

/** The single frame a room socket ever sends. */
export interface PokeFrame {
  readonly type: "poke";
}

/** The single poke frame a room socket sends, as a value to serialize. */
export const pokeFrame: PokeFrame = { type: "poke" };

/** Re-exported request decoders — the room's HTTP bodies are the protocol's. */
export const decodePushRequest: Decoder<Protocol.PushRequest> = Protocol.decodePushRequest;
/** The protocol's pull-request decoder. */
export const decodePullRequest: Decoder<Protocol.PullRequest> = Protocol.decodePullRequest;
/** The protocol's read-request decoder. */
export const decodeReadRequest: Decoder<Protocol.ReadRequest> = Protocol.decodeReadRequest;
