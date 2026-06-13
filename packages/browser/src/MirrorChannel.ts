/**
 * MirrorChannel
 *
 * The tab↔engine-host message carrier seam (ADR-0010): one more
 * implementation of "schema-defined messages over a pluggable carrier".
 * BroadcastChannel is the shipped browser implementation; the loopback
 * pair serves tests and same-thread (no-service-worker) hosting.
 *
 * `subscribe` is deliberately effectful and eager — the subscription is
 * established once the effect completes — so hosts and mirrors can
 * subscribe first and fork their processing loops afterwards without a
 * subscribe/publish race.
 */

import { TransportError } from "@thomasfosterau/effect-sync-core";
import { Effect, PubSub, Queue, Scope } from "effect";

/** A live inbound subscription. */
export interface MirrorInbox {
  /** The next inbound message; suspends until one arrives. */
  readonly take: Effect.Effect<unknown>;
}

export interface MirrorChannel {
  readonly post: (message: unknown) => Effect.Effect<void, TransportError>;
  /**
   * Subscribe to inbound messages. Messages posted by this side are not
   * received by it (BroadcastChannel semantics).
   */
  readonly subscribe: Effect.Effect<MirrorInbox, never, Scope.Scope>;
}

/**
 * A MirrorChannel over a `BroadcastChannel` name. Pair one in the engine
 * host with one per tab.
 */
export const makeBroadcastChannel = (
  name: string
): Effect.Effect<MirrorChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    const channel = yield* Effect.acquireRelease(
      Effect.sync(() => new BroadcastChannel(name)),
      (ch) => Effect.sync(() => ch.close())
    );
    return {
      post: (message) =>
        Effect.try({
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no targetOrigin
          try: () => channel.postMessage(message),
          catch: (cause) => new TransportError({ message: `BroadcastChannel post failed`, cause }),
        }),
      subscribe: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<unknown>();
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (event: MessageEvent) => {
              Queue.offerUnsafe(queue, event.data);
            };
            channel.addEventListener("message", listener as EventListener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => channel.removeEventListener("message", listener as EventListener))
        );
        return { take: Queue.take(queue).pipe(Effect.orDie) };
      }),
    };
  });

/**
 * Two linked in-memory channels: messages posted on one side arrive on the
 * other. For tests and main-thread hosting (the documented degraded mode
 * for environments without service workers).
 */
export const makeLoopbackPair: Effect.Effect<
  { readonly host: MirrorChannel; readonly tab: MirrorChannel },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const makeHub = Effect.acquireRelease(PubSub.unbounded<unknown>(), (hub) => PubSub.shutdown(hub));
  const toHost = yield* makeHub;
  const toTab = yield* makeHub;
  const side = (outbound: typeof toHost, inbound: typeof toTab): MirrorChannel => ({
    post: (message) => Effect.asVoid(PubSub.publish(outbound, message)),
    subscribe: PubSub.subscribe(inbound).pipe(
      Effect.map((subscription) => ({ take: PubSub.take(subscription) }))
    ),
  });
  return { host: side(toTab, toHost), tab: side(toHost, toTab) };
});
