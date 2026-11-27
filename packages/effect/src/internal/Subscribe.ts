import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Start a lazy stream's subscription now, in the caller's scope, and return a stream of what it
 * receives from then on. A listener-backed stream (`Stream.fromEventListener`, `Stream.callback`)
 * registers its listener only when run, so an eager `subscribe` seam opens it here: nothing
 * delivered after this effect completes is missed, however late the returned stream is run. The
 * returned stream is single-use and ends when the scope closes.
 */
export const subscribeNow = <A>(
  stream: Stream.Stream<A>
): Effect.Effect<Stream.Stream<A>, never, Scope.Scope> =>
  Effect.map(Stream.toPull(stream), (pull) => Stream.fromPull(Effect.succeed(pull)));
