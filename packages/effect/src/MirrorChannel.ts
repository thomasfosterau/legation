/**
 * MirrorChannel
 *
 * The mirror↔engine-host message carrier seam (ADR-0010): one more
 * implementation of "schema-defined messages over a pluggable carrier".
 * The BroadcastChannel implementation ships in `@thomasfosterau/legation-browser`
 * (`BroadcastMirrorChannel`); the loopback pair here serves tests and
 * same-process (no-service-worker) hosting on any runtime.
 *
 * `subscribe` is deliberately effectful and eager — the subscription is
 * established once the effect completes — so hosts and mirrors can
 * subscribe first and run the returned stream afterwards without a
 * subscribe/publish race.
 */

import type { TransportError } from "./Errors.js";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Subscribe from "./internal/Subscribe.js";

/** The message channel between an engine host and its mirrors, with BroadcastChannel semantics. */
export interface MirrorChannel {
  readonly post: (message: unknown) => Effect.Effect<void, TransportError>;
  /**
   * Subscribe to inbound messages: the subscription is open once the effect completes, and the
   * stream (single-use) emits every message received from then on, in order, ending when the
   * scope closes. Messages posted by this side are not received by it (BroadcastChannel
   * semantics).
   */
  readonly subscribe: Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
}

/**
 * Open a lazy stream's subscription now, for an eager `subscribe`: wrap a
 * `Stream.fromEventListener` (or `Stream.callback`) source with it, and nothing
 * delivered after the effect completes is missed, however late the returned
 * single-use stream is run. It ends when the scope closes.
 */
export const subscribeNow: <A>(
  stream: Stream.Stream<A>
) => Effect.Effect<Stream.Stream<A>, never, Scope.Scope> = Subscribe.subscribeNow;

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
    subscribe: Effect.map(PubSub.subscribe(inbound), Stream.fromSubscription),
  });
  return { host: side(toMirror, toHost), mirror: side(toHost, toMirror) };
});
