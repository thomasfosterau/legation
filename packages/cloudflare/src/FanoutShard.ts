/**
 * FanoutShard
 *
 * The Durable Object side of ADR-0023's broker: one shard instance per
 * topic (Cloudflare names the object BY the topic, so cardinality is
 * managed by the platform — cold topics cost nothing until registered).
 * The shard holds **leases** in its transactional storage: `roomId →
 * expiresAt` for its topic. `register` writes a lease, `publish` pokes
 * every unexpired room by calling the room object's `/poke` route, and
 * expired leases are dropped as publishes pass by — crashed rooms age out
 * with no distributed cleanup.
 *
 * `makeShardClass` returns a class to export from the Worker entry:
 *
 * ```ts
 * export class LegationShard extends makeShardClass({ rooms: (env) => env.ROOMS }) {}
 * ```
 */

import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";
import * as DateTime from "effect/DateTime";
import { routes } from "./RoomProtocol.js";

/**
 * The wall clock in epoch milliseconds. A Durable Object's `fetch` runs
 * outside any Effect runtime, so there is no `Clock` service to read here.
 */
const nowMillis = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

const LEASE_PREFIX = "legation:lease:";

/** The lease operations, storage-backed (exported for direct testing). */
export const leases = {
  register: async (
    storage: DurableObjectStorage,
    roomId: string,
    ttlMillis: number,
    now: number
  ): Promise<void> => {
    await storage.put(`${LEASE_PREFIX}${roomId}`, now + ttlMillis);
  },
  /** The unexpired room ids; expired entries are deleted as a side effect. */
  live: async (storage: DurableObjectStorage, now: number): Promise<ReadonlyArray<string>> => {
    const all = await storage.list<number>({ prefix: LEASE_PREFIX });
    const entries = [...all];
    // Expired leases are deleted one at a time, in listing order.
    await entries
      .filter(([, expiresAt]) => expiresAt <= now)
      .reduce<Promise<unknown>>(
        (previous, [key]) => previous.then(() => storage.delete(key)),
        Promise.resolve()
      );
    return entries
      .filter(([, expiresAt]) => expiresAt > now)
      .map(([key]) => key.slice(LEASE_PREFIX.length));
  },
};

/** Configuration for {@link makeShardClass}. */
export interface ShardConfig<Env> {
  /** The room namespace binding — rooms are addressed by their room id. */
  readonly rooms: (env: Env) => DurableObjectNamespace;
}

/**
 * Build the shard's Durable Object class. Routes:
 * `POST /register { roomId, ttlMillis }` (topics implicit — the object IS
 * the topic) and `POST /publish { topics }` — the publisher fans one
 * request out per topic shard; each shard pokes its own leased rooms.
 */
export const makeShardClass = <Env>(config: ShardConfig<Env>) =>
  class FanoutShard {
    constructor(
      readonly state: DurableObjectState,
      readonly env: Env
    ) {}

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/register") {
        const body = (await request.json()) as { roomId: string; ttlMillis: number };
        await leases.register(this.state.storage, body.roomId, body.ttlMillis, nowMillis());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/publish") {
        const body = (await request.json()) as { topics: ReadonlyArray<string> };
        const rooms = config.rooms(this.env);
        const alive = await leases.live(this.state.storage, nowMillis());
        await Promise.all(
          alive.map((roomId) =>
            rooms
              .get(rooms.idFromName(roomId))
              .fetch(`https://room${routes.poke}`, {
                method: "POST",
                body: JSON.stringify({ topics: body.topics }),
                headers: { "content-type": "application/json" },
              })
              // A dead room only delays its own next pull.
              .catch(() => undefined)
          )
        );
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }
  };
