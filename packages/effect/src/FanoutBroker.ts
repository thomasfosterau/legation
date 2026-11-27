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
 * pull, never prevents convergence, and counts towards
 * `legation_fanout_pokes_dropped_total`.
 */

import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Topic } from "./FanoutTopics.js";
import * as Telemetry from "./Telemetry.js";

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
  /**
   * A room's poke feed: each batch of matched topics, in order. Established once the effect
   * completes; the stream is single-use and ends when the scope closes.
   */
  readonly pokes: (
    roomId: string
  ) => Effect.Effect<Stream.Stream<ReadonlyArray<Topic>>, never, Scope.Scope>;
}

/**
 * The {@link FanoutBroker} service tag, for apps that provide a broker by layer;
 * `FanoutBus.make` takes it as an option.
 */
export const FanoutBroker = Context.Service<FanoutBroker>("@thomasfosterau/legation/FanoutBroker");

interface Lease {
  readonly topics: ReadonlySet<Topic>;
  readonly expiresAt: number;
}

const POKE_CAPACITY = 256;

/** The in-process broker: leases in a Ref, one dropping hub per room. */
export const makeInProcess: Effect.Effect<FanoutBroker, never, Scope.Scope> = Effect.gen(
  function* () {
    const leases = yield* Ref.make(HashMap.empty<string, Lease>());
    const hubs = yield* Ref.make(HashMap.empty<string, PubSub.PubSub<ReadonlyArray<Topic>>>());
    const scope = yield* Effect.scope;

    const hubFor = Effect.fnUntraced(function* (roomId: string) {
      const existing = HashMap.get(yield* Ref.get(hubs), roomId);
      if (Option.isSome(existing)) return existing.value;
      const hub = yield* PubSub.dropping<ReadonlyArray<Topic>>({ capacity: POKE_CAPACITY });
      yield* Scope.addFinalizer(scope, PubSub.shutdown(hub));
      yield* Ref.update(hubs, HashMap.set(roomId, hub));
      return hub;
    });

    return {
      register: Effect.fnUntraced(function* (roomId, topics, ttl) {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(
          leases,
          HashMap.set(roomId, { topics, expiresAt: now + Duration.toMillis(ttl) })
        );
      }),
      publish: Effect.fnUntraced(function* (topics) {
        const wanted = Arr.dedupe(topics);
        const now = yield* Clock.currentTimeMillis;
        // Lazy lease sweep: expired rooms drop out as publishes pass by.
        const live = HashMap.filter(yield* Ref.get(leases), (lease) => lease.expiresAt > now);
        yield* Ref.set(leases, live);
        const hubMap = yield* Ref.get(hubs);
        yield* Effect.forEach(
          live,
          ([roomId, lease]) =>
            Effect.gen(function* () {
              const matched = wanted.filter((topic) => lease.topics.has(topic));
              if (Arr.isReadonlyArrayEmpty(matched)) return;
              const hub = HashMap.get(hubMap, roomId);
              if (Option.isNone(hub)) return;
              const published = yield* PubSub.publish(hub.value, matched);
              if (!published) yield* Metric.update(Telemetry.fanoutPokesDroppedTotal, 1);
            }),
          { concurrency: 1, discard: true }
        );
      }),
      pokes: Effect.fnUntraced(function* (roomId) {
        const hub = yield* hubFor(roomId);
        return Stream.fromSubscription(yield* PubSub.subscribe(hub));
      }),
    };
  }
);
