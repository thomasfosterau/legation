/**
 * FanoutShard
 *
 * The Durable Object side of ADR-0023's broker, as an Alchemy Durable Object:
 * one shard instance per topic (the object is named BY the topic, so
 * cardinality is managed by the platform — cold topics cost nothing until
 * registered). The shard holds **leases** in its transactional storage:
 * `roomId → expiresAt` for its topic. `register` writes a lease; `publish`
 * answers the unexpired rooms, and expired leases are dropped as publishes pass
 * by — crashed rooms age out with no distributed cleanup.
 *
 * The publishing room pokes the rooms a shard answers
 * (`DurableFanoutBroker`), rather than the shard calling the rooms itself:
 * a shard that called rooms would need the room namespace, and the room needs
 * the shard namespace, which Alchemy's layers cannot provide to each other.
 * Answering the room ids keeps the shard free of any binding.
 *
 * The app declares the class and binds this implementation to it:
 *
 * ```ts
 * export class LegationShard extends Cloudflare.DurableObject<
 *   LegationShard,
 *   FanoutShard.ShardObject
 * >()("LegationShard") {}
 *
 * export const LegationShardLive = LegationShard.make(FanoutShard.make());
 * ```
 */

import * as Workers from "@alchemy.run/cloudflare/Workers";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const LEASE_PREFIX = "legation:lease:";

/** The shard's RPC surface, as the room-side broker calls it through a stub. */
export interface ShardObject {
  /** Lease (or renew) `roomId` on this shard's topic for `ttlMillis`. */
  readonly register: (
    roomId: string,
    ttlMillis: number
  ) => Effect.Effect<void, never, RuntimeContext>;
  /**
   * A publish to this shard's topic: the rooms whose lease is still live, to be
   * poked by the publisher. Expired leases are deleted as a side effect.
   */
  readonly publish: () => Effect.Effect<ReadonlyArray<string>, never, RuntimeContext>;
}

/** The lease operations, storage-backed (exported for direct testing). */
export const leases = {
  register: (
    storage: Workers.DurableObjectStorage,
    roomId: string,
    ttlMillis: number,
    now: number
  ): Effect.Effect<void, never, RuntimeContext> =>
    storage.put(`${LEASE_PREFIX}${roomId}`, now + ttlMillis),
  /** The unexpired room ids, in listing order; expired entries are deleted as a side effect. */
  live: (
    storage: Workers.DurableObjectStorage,
    now: number
  ): Effect.Effect<ReadonlyArray<string>, never, RuntimeContext> =>
    Effect.gen(function* () {
      const entries = [...(yield* storage.list<number>({ prefix: LEASE_PREFIX }))];
      const expired = entries.filter(([, expiresAt]) => expiresAt <= now).map(([key]) => key);
      if (Arr.isReadonlyArrayNonEmpty(expired)) yield* storage.delete(expired);
      return entries
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([key]) => key.slice(LEASE_PREFIX.length));
    }),
};

/**
 * The shard's Durable Object implementation, for `LegationShard.make(...)`:
 * its state is resolved at init, its leases read and written per call.
 */
export const make = (): Effect.Effect<
  Effect.Effect<ShardObject>,
  never,
  Workers.DurableObjectState
> =>
  Effect.gen(function* () {
    const state = yield* Workers.DurableObjectState;
    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Alchemy's two-phase Durable Object contract: init returns the per-instance Effect, which the provider runs per instance
    return Effect.succeed({
      register: (roomId, ttlMillis) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          leases.register(state.storage, roomId, ttlMillis, now)
        ),
      publish: () =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => leases.live(state.storage, now)),
    });
  });
