/**
 * HintSource
 *
 * A HintSource produces ChangeHints for writes that bypass mutators (CDC —
 * cron jobs, admin tools, another service, psql), publishing them to the
 * InvalidationBus so out-of-band changes poke subscribed clients. Fork its
 * `run` into a scope alongside the SyncServer.
 *
 * Correctness is preserved regardless: a HintSource only pokes, and poke is
 * never a correctness dependency (ADR-0009) — a missed or redundant hint only
 * changes when the next pull happens. A source that publishes value-less hints
 * (no `values`) is matched at the collection level by the #42 fan-out matcher,
 * which is sound: over-matching a poke costs an empty pull, under-matching would
 * delay convergence, so a hint that names only a collection pokes every group
 * subscribed to it.
 */

import { Effect, Scope, Stream } from "effect";
import type { ChangeHint } from "./Backend.js";
import * as InvalidationBus from "./InvalidationBus.js";

export interface HintSource {
  /** Run until the scope closes; publishes to the in-context InvalidationBus. */
  readonly run: Effect.Effect<void, never, InvalidationBus.InvalidationBus | Scope.Scope>;
}

/**
 * Build a HintSource from a stream of hint batches (used by the LISTEN/NOTIFY
 * recipe and tests): each emitted batch is published to the in-context bus, and
 * the consuming fibre is tied to the scope so it stops when the scope closes.
 */
export const fromStream = (hints: Stream.Stream<ReadonlyArray<ChangeHint>>): HintSource => ({
  run: Effect.flatMap(InvalidationBus.InvalidationBus, (bus) =>
    Effect.asVoid(Effect.forkScoped(Stream.runForEach(hints, bus.publish)))
  ),
});

/**
 * Fork a HintSource for the caller's scope, resolving the bus from context: the
 * source's worker runs on a scoped fibre alongside the SyncServer and is
 * interrupted when the scope closes.
 */
export const run = (
  source: HintSource
): Effect.Effect<void, never, InvalidationBus.InvalidationBus | Scope.Scope> => source.run;
