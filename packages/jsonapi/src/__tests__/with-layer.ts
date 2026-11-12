import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

/**
 * Runs an effect with `layer` built for it alone and released when it finishes: one phase of a test
 * that opens a store, closes it and opens it again (a restart), or that gives one step its own
 * services. A layer shared by every test of a suite goes through `layer(...)` from
 * `@effect/vitest` instead.
 */
export const withLayer =
  <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  <A, E2, R>(self: Effect.Effect<A, E2, R>): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>> =>
    Effect.acquireUseRelease(
      Scope.make(),
      (scope) =>
        Layer.buildWithScope(layer, scope).pipe(
          Effect.flatMap((context) => Effect.provideContext(self, context))
        ),
      (scope, exit) => Scope.close(scope, exit)
    );
