/**
 * FanoutBroker
 *
 * ADR-0023's shard seam: topic pub/sub with **leased** registrations.
 * Rooms register the topic set their windows compile to and renew on a
 * heartbeat; shards drop expired entries, so crashed rooms age out with no
 * distributed cleanup. `publish` routes a write's derived topics to every
 * room whose live lease intersects them — the fan-out layer never
 * evaluates a predicate.
 *
 * The in-process implementation is the single-process reference (and the
 * semantics a Durable Object or Redis shard must match). A poke here is a
 * batch of matched topics; a dropped poke only delays the next interval
 * pull, never prevents convergence.
 */

import { Clock, Context, Duration, Effect, PubSub, Ref, Scope } from "effect";
import type { Topic } from "./FanoutTopics.js";

/** A live subscription to a room's topic pokes. */
export interface TopicPokes {
  /** The next batch of matched topics; suspends until one arrives. */
  readonly take: Effect.Effect<ReadonlyArray<Topic>>;
}

/**
 * Topic pub/sub with leased registrations: rooms lease the topics their windows compile to, and
 * `publish` pokes every room whose live lease intersects a write's topics.
 */
export interface FanoutBroker {
  /**
   * Lease (or replace) a room's topic registrations. The lease expires
   * after `ttl` unless re-registered — registration is idempotent, so the
   * heartbeat IS re-registration.
   */
  readonly register: (
    roomId: string,
    topics: ReadonlySet<Topic>,
    ttl: Duration.Input
  ) => Effect.Effect<void>;
  /** Route derived topics to every room whose live lease intersects them. */
  readonly publish: (topics: Iterable<Topic>) => Effect.Effect<void>;
  /** A room's poke feed. Established once the effect completes. */
  readonly pokes: (roomId: string) => Effect.Effect<TopicPokes, never, Scope.Scope>;
}

/** The {@link FanoutBroker} service. */
export const FanoutBroker = Context.Service<FanoutBroker>("@legation/effect/FanoutBroker");

interface Lease {
  readonly topics: ReadonlySet<Topic>;
  readonly expiresAt: number;
}

const POKE_CAPACITY = 256;

/** The in-process broker: leases in a Ref, one dropping hub per room. */
export const makeInProcess: Effect.Effect<FanoutBroker, never, Scope.Scope> = Effect.gen(
  function* () {
    const leases = yield* Ref.make(new Map<string, Lease>());
    const hubs = yield* Ref.make(new Map<string, PubSub.PubSub<ReadonlyArray<Topic>>>());
    const scope = yield* Effect.scope;

    const hubFor = (roomId: string) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(hubs)).get(roomId);
        if (existing !== undefined) return existing;
        const hub = yield* PubSub.dropping<ReadonlyArray<Topic>>({ capacity: POKE_CAPACITY });
        yield* Scope.addFinalizer(scope, PubSub.shutdown(hub));
        yield* Ref.update(hubs, (map) => new Map(map).set(roomId, hub));
        return hub;
      });

    return {
      register: (roomId, topics, ttl) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(leases, (map) =>
            new Map(map).set(roomId, { topics, expiresAt: now + Duration.toMillis(ttl) })
          );
        }),
      publish: (topics) =>
        Effect.gen(function* () {
          const wanted = new Set(topics);
          const now = yield* Clock.currentTimeMillis;
          // Lazy lease sweep: expired rooms drop out as publishes pass by.
          const live = new Map<string, Lease>();
          for (const [roomId, lease] of yield* Ref.get(leases)) {
            if (lease.expiresAt > now) live.set(roomId, lease);
          }
          yield* Ref.set(leases, live);
          const hubMap = yield* Ref.get(hubs);
          for (const [roomId, lease] of live) {
            const matched = [...wanted].filter((topic) => lease.topics.has(topic));
            if (matched.length === 0) continue;
            const hub = hubMap.get(roomId);
            if (hub !== undefined) yield* PubSub.publish(hub, matched);
          }
        }),
      pokes: (roomId) =>
        Effect.gen(function* () {
          const hub = yield* hubFor(roomId);
          const subscription = yield* PubSub.subscribe(hub);
          return { take: PubSub.take(subscription) };
        }),
    };
  }
);
