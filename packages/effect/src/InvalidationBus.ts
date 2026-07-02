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

import { Context, Effect, Layer, Metric, PubSub, Schema, Scope } from "effect";
import type { ChangeHint } from "./Backend.js";
import * as Telemetry from "./Telemetry.js";

/**
 * Default capacity for the bounded in-process bus and memory broker. Hints are
 * small "pull soon" batches; 1024 buffered batches is ample headroom before a
 * slow consumer sheds load, and correctness never depends on the bus.
 */
const DEFAULT_CAPACITY = 1024;

/** Bounding options shared by the in-process bus and the memory broker. */
export interface BusCapacityOptions {
  /** PubSub capacity before publishes are dropped. Defaults to 1024. */
  readonly capacity?: number;
}

/**
 * Count a dropped publish: a bounded bus PubSub returns `false` when a publish
 * overflows (dropping strategy at capacity). A dropped hint only delays the
 * next pull (ADR-0009), so we tally it and move on.
 */
const countIfDropped = (published: boolean): Effect.Effect<void> =>
  published ? Effect.void : Metric.update(Telemetry.hintsDroppedTotal, 1);

/** Subscribe to a PubSub and expose a `take`-only handle (shared by the bus and broker). */
const takeHandle = <A>(
  pubsub: PubSub.PubSub<A>
): Effect.Effect<{ readonly take: Effect.Effect<A> }, never, Scope.Scope> =>
  PubSub.subscribe(pubsub).pipe(
    Effect.map((subscription) => ({ take: PubSub.take(subscription) }))
  );

/**
 * Allocate a bounded, dropping PubSub (shut down with the scope) plus a
 * `publish` that tallies overflows — the backpressure primitive shared by the
 * in-process bus and the memory broker (#44).
 */
const droppingHub = <A>(
  capacity?: number
): Effect.Effect<
  { readonly pubsub: PubSub.PubSub<A>; readonly publish: (value: A) => Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.dropping<A>({ capacity: capacity ?? DEFAULT_CAPACITY }),
      (hub) => PubSub.shutdown(hub)
    );
    return {
      pubsub,
      publish: (value) => PubSub.publish(pubsub, value).pipe(Effect.flatMap(countIfDropped)),
    };
  });

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

/**
 * In-process bus over a bounded, dropping PubSub (#44).
 *
 * Delivery guarantee: the hub is bounded (`dropping` at `capacity`) so a bus
 * consumer that falls behind cannot make the publisher grow the queue without
 * limit. On overflow the newest hint batch is dropped and
 * `legation_hints_dropped_total` is incremented. Dropping a hint only delays
 * convergence — the next pull recovers the missed change (ADR-0009), so
 * correctness never depends on the bus. Capacity is configurable; the default
 * is generous ({@link DEFAULT_CAPACITY}).
 */
export const makeInProcessWith = (
  options?: BusCapacityOptions
): Effect.Effect<InvalidationBus, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hub = yield* droppingHub<ReadonlyArray<ChangeHint>>(options?.capacity);
    return InvalidationBus.of({
      publish: (hints) => (hints.length === 0 ? Effect.void : hub.publish(hints)),
      subscribe: takeHandle(hub.pubsub),
    });
  });

/** In-process bus with the default capacity. */
export const makeInProcess: Effect.Effect<InvalidationBus, never, Scope.Scope> =
  makeInProcessWith();

export const layerInProcess: Layer.Layer<InvalidationBus> =
  Layer.effect(InvalidationBus)(makeInProcess);

/** In-process bus layer with a configurable capacity. */
export const layerInProcessWith = (options?: BusCapacityOptions): Layer.Layer<InvalidationBus> =>
  Layer.effect(InvalidationBus)(makeInProcessWith(options));

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

/**
 * Wire form of a change-hint batch: a JSON array of `{ collection, ids }`,
 * plus an optional `values` carrying the current row values of the PUTs (for
 * predicate-level fan-out matching). The field is optional for wire
 * compatibility: an old hint with no `values` decodes and behaves exactly as
 * before (a collection-level match).
 */
const HintsFromJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      collection: Schema.String,
      ids: Schema.Array(Schema.String),
      values: Schema.optional(
        Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown }))
      ),
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
 * An in-memory broker over a shared, bounded PubSub: every bus built on the
 * same broker exchanges hints, modelling several instances on one process. The
 * reference broker for tests and the executable shape a real broker mimics.
 *
 * Delivery guarantee (#44): bounded with a `dropping` strategy, matching the
 * in-process bus — a lagging subscriber cannot make a publisher grow the queue
 * without limit. An overflowing publish is dropped and counted in
 * `legation_hints_dropped_total`; the next pull repairs any missed hint
 * (ADR-0009). Capacity is configurable, defaulting to {@link DEFAULT_CAPACITY}.
 */
export const makeMemoryBrokerWith = (
  options?: BusCapacityOptions
): Effect.Effect<BusBroker, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hub = yield* droppingHub<string>(options?.capacity);
    return { publish: hub.publish, subscribe: takeHandle(hub.pubsub) };
  });

/** In-memory broker with the default capacity. */
export const makeMemoryBroker: Effect.Effect<BusBroker, never, Scope.Scope> =
  makeMemoryBrokerWith();
