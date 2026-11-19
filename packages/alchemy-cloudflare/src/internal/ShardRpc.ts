/**
 * ShardRpc
 *
 * The fan-out shard's Durable Object RPC surface (`FanoutShard.ShardObject`).
 * This module is private: `FanoutShard` re-exports the interface.
 * `effecttsgo/lazy-effect` is off for this module alone, in the root
 * `vite.config.ts`.
 */

import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

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
   *
   * A method, not an `Effect` member: Alchemy's stub turns every member access
   * into a call (`(...args) => stub[member](...args)`), so the broker can only
   * call `publish()` across the RPC boundary. The shard is named by its topic,
   * so the method has no argument to take.
   */
  readonly publish: () => Effect.Effect<ReadonlyArray<string>, never, RuntimeContext>;
}
