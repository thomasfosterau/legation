/**
 * BroadcastMirrorChannel
 *
 * The browser binding of the `MirrorChannel` seam: schema-defined mirror
 * protocol messages over a `BroadcastChannel` name. Pair one in the engine
 * host with one per client context (tab, window, worker) — BroadcastChannel
 * semantics mean a side never receives its own posts.
 */
import { TransportError } from "@thomasfosterau/legation";
import { MirrorChannel } from "@thomasfosterau/legation/internal";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

/** A {@link MirrorChannel.MirrorChannel} over a `BroadcastChannel` name. */
export const make: (
  name: string
) => Effect.Effect<MirrorChannel.MirrorChannel, never, Scope.Scope> = Effect.fn(
  "legation-browser/BroadcastMirrorChannel.make"
)(function* (name) {
  const channel = yield* Effect.acquireRelease(
    Effect.sync(() => new BroadcastChannel(name)),
    (ch) => Effect.sync(() => ch.close())
  );
  return {
    post: (message) =>
      Effect.try({
        try: () => channel.postMessage(message),
        catch: (cause) => new TransportError({ message: `BroadcastChannel post failed`, cause }),
      }),
    subscribe: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<unknown>();
      const listener = (event: MessageEvent) => {
        Queue.offerUnsafe(queue, event.data);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => channel.addEventListener("message", listener)),
        () => Effect.sync(() => channel.removeEventListener("message", listener))
      );
      return { take: Queue.take(queue) };
    }),
  };
});
