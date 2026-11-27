import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Subscribe and take the stream's elements one at a time: `take` suspends until the next one
 * arrives, and dies if the stream ends.
 */
export const takes = <A, R>(
  subscribe: Effect.Effect<Stream.Stream<A>, never, R>
): Effect.Effect<{ readonly take: Effect.Effect<A> }, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(Stream.rechunk(yield* subscribe, 1));
    return { take: pull.pipe(Effect.map(Arr.headNonEmpty), Effect.orDie) };
  });
