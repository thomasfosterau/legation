/**
 * FanoutBus
 *
 * An {@link InvalidationBus} over a {@link FanoutBroker} — the piece that
 * makes ADR-0023's topic routing a drop-in: `Server.make({ bus })` accepts
 * it unchanged, and the room deployment gets topic-precise cross-room
 * fan-out instead of a flat channel.
 *
 * Publishing derives each hint's topics (coarse always; fine per derivable
 * field of the old and new values) and hands them to the broker. The
 * subscription side surfaces the broker's topic pokes as collection-level
 * hints — within a room the group count is small (typically one user), so
 * the sync server's existing matcher finishes the job.
 *
 * Registration: the room's current windows compile to topics
 * ({@link FanoutTopics.topicForSubset}) and are leased on a heartbeat —
 * registration is idempotent, so the heartbeat IS renewal, and a crashed
 * room simply ages out shard-side.
 */

import { Duration, Effect, Scope } from "effect";
import type { ChangeHint } from "./Backend.js";
import type { FanoutBroker } from "./FanoutBroker.js";
import * as FanoutTopics from "./FanoutTopics.js";
import type { InvalidationBus } from "./InvalidationBus.js";
import type * as Node from "./Node.js";
import type * as Subset from "./Subset.js";

/**
 * Options for {@link make}: this room's id at the broker, the broker, and the node graph topics
 * are derived from.
 */
export interface MakeOptions {
  /** This room's identity at the broker (typically the user id). */
  readonly roomId: string;
  readonly broker: FanoutBroker;
  /** The node graph — the derivable sets both derivation sides agree on. */
  readonly nodes: Node.NodeRegistry;
  /**
   * The room's current windows (e.g. the authorized subsets of its client
   * groups, from the sync server's introspection). Re-evaluated on every
   * heartbeat, so new subscriptions register within one beat.
   */
  readonly subsets: Effect.Effect<ReadonlyArray<Subset.Subset>>;
  /** Lease heartbeat. Default 10 seconds. */
  readonly heartbeat?: Duration.Input;
  /** Lease time-to-live. Default 3× the heartbeat. */
  readonly ttl?: Duration.Input;
  /**
   * Bound on each broker call the bus makes (a publish, a lease registration). A call that
   * exceeds it is logged and dropped, since a lost poke only delays the next pull (ADR-0009).
   * `publish` runs inside the sync server's uninterruptible commit-and-publish region, so this
   * bound is what keeps a hung broker from holding that region open. Default 5 seconds.
   */
  readonly timeout?: Duration.Input;
}

/** The topics one hint derives (coarse + fine over old and new values). */
const topicsForHint = (
  hint: ChangeHint,
  derivable: ReadonlySet<string> | undefined
): ReadonlySet<FanoutTopics.Topic> => {
  const values = new Map(hint.values?.map(({ id, value }) => [id, value]) ?? []);
  const olds = new Map(hint.oldValues?.map(({ id, value }) => [id, value]) ?? []);
  const topics = new Set<FanoutTopics.Topic>([FanoutTopics.coarse(hint.collection)]);
  const ids = hint.ids.length > 0 ? hint.ids : [...values.keys()];
  for (const id of ids) {
    for (const topic of FanoutTopics.topicsForWrite(hint.collection, derivable, {
      oldValue: olds.get(id),
      newValue: values.get(id),
    })) {
      topics.add(topic);
    }
  }
  return topics;
};

/** Build the bus; the lease heartbeat runs until the scope closes. */
export const make = (options: MakeOptions): Effect.Effect<InvalidationBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const derivable = FanoutTopics.derivableSets(options.nodes);
    const heartbeat = options.heartbeat ?? "10 seconds";
    const ttl = options.ttl ?? Duration.millis(Duration.toMillis(heartbeat) * 3);
    const timeout = options.timeout ?? "5 seconds";
    // Every broker call is bounded, so a hung broker drops its call instead of
    // stalling the publish that awaits it (ADR-0009: correctness never depends on the bus).
    const bounded = (what: string, call: Effect.Effect<void>): Effect.Effect<void> =>
      call.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.logWarning(
              `FanoutBus: ${what} timed out; dropped (the next heartbeat or pull recovers it)`
            ),
        })
      );

    const registerNow = bounded(
      "lease registration",
      options.subsets.pipe(
        Effect.flatMap((subsets) =>
          options.broker.register(
            options.roomId,
            new Set(
              subsets.map((subset) =>
                FanoutTopics.topicForSubset(subset, derivable.get(subset.collection))
              )
            ),
            ttl
          )
        )
      )
    );
    yield* registerNow;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(heartbeat).pipe(Effect.andThen(registerNow)))
    );

    return {
      publish: (hints) => {
        const topics = new Set<FanoutTopics.Topic>();
        for (const hint of hints) {
          for (const topic of topicsForHint(hint, derivable.get(hint.collection))) {
            topics.add(topic);
          }
        }
        // Freshen the lease alongside the write — a busy room never expires.
        return bounded("publish", options.broker.publish(topics)).pipe(Effect.andThen(registerNow));
      },
      subscribe: Effect.gen(function* () {
        const pokes = yield* options.broker.pokes(options.roomId);
        return {
          take: pokes.take.pipe(
            Effect.map((topics) => {
              const collections = new Set(topics.map(FanoutTopics.collectionOf));
              return [...collections].map((collection) => ({ collection, ids: [] }));
            })
          ),
        };
      }),
    };
  });
