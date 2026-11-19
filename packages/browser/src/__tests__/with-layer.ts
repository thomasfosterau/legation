import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

/**
 * Runs an effect with `layer` built for it alone and released when it finishes.
 *
 * For a layer that changes in the middle of one test, which `layer(...)` / `it.layer` from
 * `@effect/vitest` cannot express because they build one layer per test or per suite, before the
 * test body runs. Use it only when the layer depends on something the test does first or on a value
 * it creates: a store reopened over the same database after a restart (a second layer over data the
 * first one wrote), a layer built from a client or server made in the test body, or a database that
 * must exist before the layer opens it. A layer a whole test (or suite) can start with goes through
 * `layer(...)`, and so does anything that only differs per test.
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
