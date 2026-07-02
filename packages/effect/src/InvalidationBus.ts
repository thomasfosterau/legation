/**
 * InvalidationBus
 *
 * The pluggable channel carrying committed-write hints from the backend to
 * sync sessions, possibly across instances (ADR-0009). Fan-out is
 * poke-then-pull over this bus: instances match hints against their
 * sessions' subscriptions and poke affected client groups. Correctness
 * never depends on the bus — a missed hint only delays the next pull.
 *
 * The in-process PubSub implementation is the default. For multi-instance
 * deployments, `makeSerialized` runs the bus over a {@link BusBroker} — a
 * single string pub/sub channel — so a Durable Object broadcast, Redis
 * pub/sub, or Postgres LISTEN/NOTIFY becomes a distributed bus by
 * implementing one tiny interface.
 */

import { Context, Effect, Layer, PubSub, Schema, Scope } from "effect";
import type { ChangeHint } from "./Backend.js";

/** A live subscription to the bus. */
export interface HintSubscription {
  /** The next hint batch; suspends until one arrives. */
  readonly take: Effect.Effect<ReadonlyArray<ChangeHint>>;
}

export interface InvalidationBus {
  readonly publish: (hints: ReadonlyArray<ChangeHint>) => Effect.Effect<void>;
  /**
   * Subscribe to hint batches. The subscription is established once the
   * effect completes — hints published afterwards are never missed, so a
   * consumer can subscribe first and start its processing loop later.
   */
  readonly subscribe: Effect.Effect<HintSubscription, never, Scope.Scope>;
}

export const InvalidationBus = Context.Service<InvalidationBus>("@legation/effect/InvalidationBus");

/** In-process bus over an unbounded PubSub. */
export const makeInProcess: Effect.Effect<InvalidationBus, never, Scope.Scope> = Effect.gen(
  function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ChangeHint>>(),
      (hub) => PubSub.shutdown(hub)
    );
    return InvalidationBus.of({
      publish: (hints) =>
        hints.length === 0 ? Effect.void : Effect.asVoid(PubSub.publish(pubsub, hints)),
      subscribe: PubSub.subscribe(pubsub).pipe(
        Effect.map((subscription) => ({ take: PubSub.take(subscription) }))
      ),
    });
  }
);

export const layerInProcess: Layer.Layer<InvalidationBus> =
  Layer.effect(InvalidationBus)(makeInProcess);

// ─── Distributed adapters ────────────────────────────────────────────────────

/**
 * A string pub/sub channel — the one primitive a distributed bus needs.
 * Every subscriber on the channel (across instances) sees every published
 * payload; the publisher's own subscriptions see it too, which is correct:
 * each instance fans the hint out to *its* local sessions.
 *
 * Concrete brokers (runtime packages or app code) implement this over a
 * Cloudflare Durable Object broadcast, Redis pub/sub, Postgres
 * LISTEN/NOTIFY, NATS, etc. — that is the entire distributed surface.
 */
export interface BusBroker {
  readonly publish: (payload: string) => Effect.Effect<void>;
  /** Subscribe to the channel; established when the effect completes. */
  readonly subscribe: Effect.Effect<{ readonly take: Effect.Effect<string> }, never, Scope.Scope>;
}

/** Wire form of a change-hint batch: a JSON array of `{ collection, ids }`. */
const HintsFromJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      collection: Schema.String,
      ids: Schema.Array(Schema.String),
    })
  )
);

/**
 * Decode a channel payload to a hint batch. Correctness never depends on the
 * bus (ADR-0009), so malformed traffic fails the decode and the consumer
 * skips it (the next pull repairs any missed poke) rather than propagating.
 */
const decodeHints = Schema.decodeUnknownEffect(HintsFromJson);

/**
 * An InvalidationBus over a {@link BusBroker}: hints are JSON-serialized
 * onto the channel and decoded back on the other side. Correctness still
 * never depends on the bus (ADR-0009), so malformed payloads are skipped
 * rather than failed — the next pull repairs any missed poke.
 */
export const makeSerialized = (broker: BusBroker): InvalidationBus =>
  InvalidationBus.of({
    publish: (hints) => (hints.length === 0 ? Effect.void : broker.publish(JSON.stringify(hints))),
    subscribe: broker.subscribe.pipe(
      Effect.map((subscription) => {
        const take: Effect.Effect<ReadonlyArray<ChangeHint>> = subscription.take.pipe(
          Effect.flatMap((payload) => decodeHints(payload).pipe(Effect.catch(() => take)))
        );
        return { take };
      })
    ),
  });

/** Layer for a serialized bus over an in-context broker. */
export const layerSerialized = (broker: BusBroker): Layer.Layer<InvalidationBus> =>
  Layer.succeed(InvalidationBus)(makeSerialized(broker));

/**
 * An in-memory broker over a shared PubSub: every bus built on the same
 * broker exchanges hints, modelling several instances on one process. The
 * reference broker for tests and the executable shape a real broker mimics.
 */
export const makeMemoryBroker: Effect.Effect<BusBroker, never, Scope.Scope> = Effect.gen(
  function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (hub) =>
      PubSub.shutdown(hub)
    );
    return {
      publish: (payload) => Effect.asVoid(PubSub.publish(pubsub, payload)),
      subscribe: PubSub.subscribe(pubsub).pipe(
        Effect.map((subscription) => ({ take: PubSub.take(subscription) }))
      ),
    };
  }
);
