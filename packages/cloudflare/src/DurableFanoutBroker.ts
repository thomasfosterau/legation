/**
 * DurableFanoutBroker
 *
 * The room-side `FanoutBroker` over the shard namespace: registration and
 * publishing address one Durable Object **per topic** (the platform's
 * `idFromName(topic)` is the shard function), and the poke feed is fed by
 * the room's inbound `/poke` route via {@link notify} — the shard calls
 * the room back, the room hands the topics to its bus.
 *
 * Registration sends one `/register` per topic; a room's topic set is
 * small (one entry per active window), and leases make the calls
 * idempotent. Publish sends one `/publish` per derived topic. Both are
 * fire-and-forget latency optimizations: a lost call only delays the next
 * interval pull.
 */

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { Duration, Effect, PubSub, Scope } from "effect";
import type { FanoutBroker, FanoutTopics } from "@thomasfosterau/legation-effect/internal";

/** Options for {@link make}. */
export interface MakeOptions {
  /** The shard namespace binding (`env.SHARDS`). */
  readonly shards: DurableObjectNamespace;
}

/** The broker plus the room's poke-inlet (wire it to the `/poke` route). */
export interface DurableBroker {
  readonly broker: FanoutBroker.FanoutBroker;
  /** Feed an inbound shard poke into the broker's subscribers. */
  readonly notify: (topics: ReadonlyArray<FanoutTopics.Topic>) => Effect.Effect<void>;
}

const post = (
  shards: DurableObjectNamespace,
  topic: string,
  path: string,
  body: unknown
): Effect.Effect<void> =>
  Effect.promise(() =>
    shards
      .get(shards.idFromName(topic))
      .fetch(`https://shard${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      })
      .then(() => undefined)
      // Fire-and-forget: pull is the correctness path.
      .catch(() => undefined)
  );

/**
 * Build the room's {@link DurableBroker} over the shard namespace; its poke feed lives as long as
 * the scope.
 */
export const make = (options: MakeOptions): Effect.Effect<DurableBroker, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      PubSub.dropping<ReadonlyArray<FanoutTopics.Topic>>({ capacity: 256 }),
      (pubsub) => PubSub.shutdown(pubsub)
    );
    return {
      broker: {
        register: (roomId, topics, ttl) =>
          Effect.forEach(
            topics,
            (topic) =>
              post(options.shards, topic, "/register", {
                roomId,
                ttlMillis: Duration.toMillis(ttl),
              }),
            { discard: true, concurrency: 8 }
          ),
        publish: (topics) =>
          Effect.forEach(
            [...topics],
            (topic) => post(options.shards, topic, "/publish", { topics: [topic] }),
            { discard: true, concurrency: 8 }
          ),
        pokes: () =>
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(hub);
            return { take: PubSub.take(subscription) };
          }),
      },
      notify: (topics) => PubSub.publish(hub, topics).pipe(Effect.asVoid),
    };
  });
