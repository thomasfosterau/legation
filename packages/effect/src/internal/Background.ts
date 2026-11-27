/**
 * Background
 *
 * Reporting for work forked into a scope that nobody joins. This module is
 * private.
 */

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Report how a background fiber stopped, other than by interruption: its
 * cause is logged at `Error` and handed to the installed `ErrorReporter`s
 * (`Effect.withErrorReporting`), so a defect in a forked loop is seen
 * instead of ending a fiber that nobody joins. The effect itself is
 * unchanged, so it still fails or dies.
 */
export const reported =
  (label: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(`${label} stopped`, cause)
      ),
      Effect.withErrorReporting
    );
