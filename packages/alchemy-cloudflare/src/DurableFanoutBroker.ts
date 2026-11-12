/**
 * DurableFanoutBroker
 *
 * The room-side `FanoutBroker` over the shard namespace of an Alchemy Durable
 * Object (`yield* LegationShard`): registration and publishing address one
 * shard **per topic** (`getByName(topic)` is the shard function), through the
 * shard's typed RPC stub (`FanoutShard.ShardObject`). A publish asks each topic's
 * shard for its leased rooms and pokes every room once, with all of its
 * matched topics, through {@link MakeOptions.poke}; the poke feed is fed by
 * {@link DurableBroker.notify} — the room hands an inbound poke's topics to
 * its bus.
 *
 * Registration sends one `register` per topic; a room's topic set is small
 * (one entry per active window), and leases make the calls idempotent. Both
 * are fire-and-forget latency optimizations: a lost call only delays the next
 * interval pull, so a failed call is dropped and a hung one is bounded by
 * {@link MakeOptions.timeout}. Alchemy's RPC stubs take no abort signal, so a
 * call that times out is abandoned rather than aborted: the broker stops
 * waiting for it, and workerd cancels it with the event that made it.
 *
 * {@link publishOutOfBand} is the same publish for a writer outside any room:
 * a cron or queue Worker that wrote rows without a mutation hands it the
 * write's `ChangeHint`s, and every room leased on the derived topics is poked
 * through the room namespace, as a push's publish pokes them.
 */

import type * as Workers from "@alchemy.run/cloudflare/Workers";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as R from "effect/Record";
import type * as Scope from "effect/Scope";
import type { Backend, Node } from "@thomasfosterau/legation";
import { type FanoutBroker, FanoutTopics } from "@thomasfosterau/legation/internal";
import type * as FanoutShard from "./FanoutShard.js";

/** Options for {@link make}. */
export interface MakeOptions {
  /** The shard namespace (`yield* LegationShard` at the room's init). */
  readonly shards: Workers.DurableObject<FanoutShard.ShardObject>;
  /**
   * Poke one room with the topics of a publish that matched its leases. The
   * room passes its own namespace's `poke` RPC (and delivers its own pokes
   * locally).
   */
  readonly poke: (
    roomId: string,
    topics: ReadonlyArray<FanoutTopics.Topic>
  ) => Effect.Effect<void, never, RuntimeContext>;
  /**
   * Bound on one shard or room call. A call that exceeds it is logged and
   * dropped, so a hung shard cannot hold the publish that awaits it. Default 5
   * seconds.
   */
  readonly timeout?: Duration.Input | undefined;
}

/** A room's poke RPC: what a publish calls on each room whose lease matched. */
export interface PokeSurface {
  /** Deliver the topics of a publish that matched the room's leases. */
  readonly poke: (
    topics: ReadonlyArray<FanoutTopics.Topic>
  ) => Effect.Effect<void, never, RuntimeContext>;
}

/** The broker plus the room's poke inlet (wire it to the room's `poke` RPC). */
export interface DurableBroker {
  readonly broker: FanoutBroker.FanoutBroker;
  /** Feed an inbound poke into the broker's subscribers. */
  readonly notify: (topics: ReadonlyArray<FanoutTopics.Topic>) => Effect.Effect<void>;
}

/** A shard's answer when its call failed or timed out: nobody to poke. */
const noRooms: ReadonlyArray<string> = [];

/** How many shard (or room) calls run at once. */
const CONCURRENCY = 8;

/**
 * Build the room's {@link DurableBroker} over the shard namespace; its poke feed
 * lives as long as the scope. Needs the room's `RuntimeContext`, which it
 * captures for its calls.
 */
export const make = (
  options: MakeOptions
): Effect.Effect<DurableBroker, never, Scope.Scope | RuntimeContext> =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext;
    const hub = yield* Effect.acquireRelease(
      PubSub.dropping<ReadonlyArray<FanoutTopics.Topic>>({ capacity: 256 }),
      (pubsub) => PubSub.shutdown(pubsub)
    );
    const timeout = options.timeout ?? "5 seconds";

    /**
     * One bounded, fire-and-forget call: a failure (the stub's `RpcCallError`
     * included, which its types do not show) is dropped, since pull is the
     * correctness path; a call past the bound is logged and dropped.
     */
    const call = <A>(
      what: string,
      effect: Effect.Effect<A, never, RuntimeContext>,
      fallback: A
    ): Effect.Effect<A> =>
      effect.pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.exit,
        Effect.map(Exit.match({ onFailure: () => fallback, onSuccess: (value) => value })),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.as(
              Effect.logWarning(`DurableFanoutBroker: ${what} timed out; dropped`),
              fallback
            ),
        })
      );

    return {
      broker: {
        register: (roomId, topics, ttl) =>
          Effect.forEach(
            topics,
            (topic) =>
              call(
                `register to shard "${topic}"`,
                options.shards.getByName(topic).register(roomId, Duration.toMillis(ttl)),
                undefined
              ),
            { discard: true, concurrency: CONCURRENCY }
          ),
        publish: (topics) =>
          Effect.gen(function* () {
            // Each topic's shard answers its leased rooms; a room leased on
            // several of the topics is poked once, with all of them.
            const answers = yield* Effect.forEach(
              [...topics],
              (topic) =>
                call(
                  `publish to shard "${topic}"`,
                  options.shards.getByName(topic).publish(),
                  noRooms
                ).pipe(Effect.map((rooms) => ({ topic, rooms }))),
              { concurrency: CONCURRENCY }
            );
            const matched = Arr.groupBy(
              Arr.flatMap(answers, ({ topic, rooms }) =>
                Arr.map(rooms, (roomId) => ({ roomId, topic }))
              ),
              ({ roomId }) => roomId
            );
            yield* Effect.forEach(
              R.toEntries(matched),
              ([roomId, matches]) =>
                call(
                  `poke of room "${roomId}"`,
                  options.poke(
                    roomId,
                    Arr.map(matches, ({ topic }) => topic)
                  ),
                  undefined
                ),
              { discard: true, concurrency: CONCURRENCY }
            );
          }),
        pokes: () =>
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(hub);
            return { take: PubSub.take(subscription) };
          }),
      },
      notify: (topics) => PubSub.publish(hub, topics).pipe(Effect.asVoid),
    };
  });

/** Options for {@link publishOutOfBand}. */
export interface OutOfBandOptions {
  /** The shard namespace (`yield* LegationShard` at the writer Worker's init). */
  readonly shards: Workers.DurableObject<FanoutShard.ShardObject>;
  /** The room namespace (`yield* LegationRoom`), through which the matched rooms are poked. */
  readonly rooms: Workers.DurableObject<PokeSurface>;
  /** The node graph the rooms derive their topics from, so the writer derives the same fine topics. */
  readonly nodes: Node.NodeRegistry;
  /**
   * Bound on the whole publish and on each shard or room call in it; a call past it is logged and
   * dropped. Default 5 seconds.
   */
  readonly timeout?: Duration.Input;
}

/**
 * Pokes every room leased on the topics of a write that bypassed the rooms (a cron or queue
 * Worker's own SQL, an import): build it once at the writer's init, then call it with the write's
 * change hints after the write commits.
 *
 * The topics are those a room's own publish derives (`FanoutTopics.topicsForHints`): the coarse
 * topic of each collection, plus a fine topic per edge or hint key in the hints' `values` and
 * `oldValues`. A hint without values derives only the coarse topic, which reaches the rooms whose
 * windows leased it; a window that leased a fine topic (an equality on an edge or hint key) then
 * converges on its next interval pull instead. Pass the written rows as `values` (and the previous
 * ones as `oldValues` for a row that moved or was deleted) to poke those too. Each shard and room call is bounded by {@link OutOfBandOptions.timeout} and
 * fire-and-forget, like a room's publish: a failed or hung call is dropped, and the rooms converge
 * on their next pull. It never fails.
 *
 * @example
 * ```ts
 * const publish = DurableFanoutBroker.publishOutOfBand({
 *   shards: yield* LegationShard,
 *   rooms: yield* LegationRoom,
 *   nodes,
 * });
 * // after the cron job's write commits
 * yield* publish([{ collection: "results", ids: [] }]);
 * ```
 */
export const publishOutOfBand = (
  options: OutOfBandOptions
): ((hints: ReadonlyArray<Backend.ChangeHint>) => Effect.Effect<void, never, RuntimeContext>) => {
  const derivable = FanoutTopics.derivableSets(options.nodes);
  const timeout = options.timeout ?? "5 seconds";
  return (hints) =>
    make({
      shards: options.shards,
      poke: (roomId, topics) => options.rooms.getByName(roomId).poke(topics),
      timeout,
    }).pipe(
      Effect.flatMap(({ broker }) => broker.publish(FanoutTopics.topicsForHints(hints, derivable))),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.logWarning("DurableFanoutBroker: out-of-band publish timed out; dropped"),
      }),
      Effect.scoped
    );
};
