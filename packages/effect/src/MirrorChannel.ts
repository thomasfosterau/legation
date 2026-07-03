/**
 * MirrorChannel
 *
 * The mirror↔engine-host message carrier seam (ADR-0010): one more
 * implementation of "schema-defined messages over a pluggable carrier".
 * The BroadcastChannel implementation ships in `@legation/browser`
 * (`BroadcastMirrorChannel`); the loopback pair here serves tests and
 * same-process (no-service-worker) hosting on any runtime.
 *
 * `subscribe` is deliberately effectful and eager — the subscription is
 * established once the effect completes — so hosts and mirrors can
 * subscribe first and fork their processing loops afterwards without a
 * subscribe/publish race.
 */

import type { TransportError } from "./Errors.js";
import { Effect, PubSub, Scope } from "effect";

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
 * Two linked in-memory channels: messages posted on one side arrive on the
 * other. For tests and main-thread hosting (the documented degraded mode
 * for environments without service workers).
 */
export const makeLoopbackPair: Effect.Effect<
  { readonly host: MirrorChannel; readonly mirror: MirrorChannel },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const makeHub = Effect.acquireRelease(PubSub.unbounded<unknown>(), (hub) => PubSub.shutdown(hub));
  const toHost = yield* makeHub;
  const toMirror = yield* makeHub;
  const side = (outbound: typeof toHost, inbound: typeof toMirror): MirrorChannel => ({
    post: (message) => Effect.asVoid(PubSub.publish(outbound, message)),
    subscribe: PubSub.subscribe(inbound).pipe(
      Effect.map((subscription) => ({ take: PubSub.take(subscription) }))
    ),
  });
  return { host: side(toMirror, toHost), mirror: side(toHost, toMirror) };
});
