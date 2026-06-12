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

import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect";
import type { ChangeHint } from "./Backend.js";

export interface InvalidationBus {
  readonly publish: (hints: ReadonlyArray<ChangeHint>) => Effect.Effect<void>;
  readonly hints: Stream.Stream<ReadonlyArray<ChangeHint>>;
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
      hints: Stream.fromPubSub(pubsub),
    });
  }
);

export const layerInProcess: Layer.Layer<InvalidationBus> =
  Layer.effect(InvalidationBus)(makeInProcess);
