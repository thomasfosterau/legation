/**
 * The engine host a worker's event listener waits for. A listener is installed at the worker
 * script's top level, before any engine exists; a host attaches later, and an event that arrives
 * first waits for it, bounded. Shared by `BackgroundSync` and `PushPoke`.
 */

import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * The worker's own runtime for a listener's runs: each closes over the attached host's services,
 * so the runtime itself supplies none.
 */
export const edge = ManagedRuntime.make(Layer.empty);

/** A slot one host at a time occupies. */
export interface HostSlot<A> {
  /** Occupy the slot for the scope's lifetime; a newer host replaces an older one. */
  readonly attach: (host: A) => Effect.Effect<void, never, Scope.Scope>;
  /** The attached host, waiting up to `timeout` for one; `None` if none attached in time. */
  readonly await: (timeout: Duration.Input) => Effect.Effect<Option.Option<A>>;
}

/** An empty slot. Synchronous, since a listener is installed synchronously. */
export const make = <A>(): HostSlot<A> => {
  const slot = edge.runSync(SubscriptionRef.make(Option.none<A>()));
  return {
    attach: (host) =>
      Effect.acquireRelease(SubscriptionRef.set(slot, Option.some(host)), () =>
        // Detach only ourselves: a newer host may already have attached.
        SubscriptionRef.update(slot, (current) =>
          Option.isSome(current) && current.value === host ? Option.none() : current
        )
      ),
    // `changes` emits the current value first and never ends, so the head exists as soon as
    // some host is attached.
    await: (timeout) =>
      SubscriptionRef.changes(slot).pipe(
        Stream.filter(Option.isSome),
        Stream.map((some) => some.value),
        Stream.runHead,
        Effect.flatMap((head) => (Option.isSome(head) ? Effect.succeed(head.value) : Effect.never)),
        Effect.timeoutOption(timeout)
      ),
  };
};
