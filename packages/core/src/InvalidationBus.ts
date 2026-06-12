/**
 * InvalidationBus
 *
 * The pluggable channel carrying committed-write hints from the backend to
 * sync sessions, possibly across instances (ADR-0009). Fan-out is
 * poke-then-pull over this bus: instances match hints against their
 * sessions' subscriptions and poke affected client groups. Correctness
 * never depends on the bus — a missed hint only delays the next pull.
 *
 * The in-process PubSub implementation is the default; distributed
 * adapters (Durable Object broadcast, Redis, LISTEN/NOTIFY) live in
 * runtime packages and implement the same service.
 */

import { Context, Effect, Layer, PubSub, Scope } from "effect";
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

export const InvalidationBus = Context.Service<InvalidationBus>(
  "@thomasfosterau/effect-sync-core/InvalidationBus"
);

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
