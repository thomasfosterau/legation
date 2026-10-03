/**
 * PollingHintSource
 *
 * A tier-2 change-data-capture hint source (ADR-0019): a scoped fibre polls
 * each configured table on an interval for a cheap change-detector and, when a
 * table's detector moves between polls, publishes a value-less `ChangeHint` for
 * that collection to the InvalidationBus. Out-of-band writes (cron jobs, admin
 * tools, another service, psql) that never went through a mutator therefore
 * still poke subscribed clients, at a bounded staleness of one poll interval.
 *
 * It uses only the existing `SqlExecutor` seam — no new driver dependency
 * (ADR-0006) — so any backend that can already run the `SqlBackend` can also run
 * this.
 *
 * The published hint is value-less (`ids: []`), so the #42 fan-out matcher falls
 * back to a collection-level match: every group subscribed to the collection is
 * poked and the next pull reconciles. That is sound — over-matching a poke costs
 * an empty pull; poke is never a correctness dependency (ADR-0009).
 *
 * Detector coverage (be honest about it): the detector is
 * `SELECT COUNT(*) AS n, MAX(version) AS v` when a `versionColumn` is mapped,
 * else `SELECT COUNT(*) AS n`. `COUNT(*) + MAX(version)` catches inserts,
 * deletes, and version-bumping updates. A table with NO monotonic
 * `versionColumn` can only detect row-count changes: an in-place update that
 * keeps the row count and has no version column is missed. Map a `versionColumn`
 * (or an `updated_at`) for full coverage.
 */

import { Effect, Ref, Schedule } from "effect";
import type { Duration } from "effect";
import { Backend, BackendError } from "@thomasfosterau/legation-effect";
import { HintSource, InvalidationBus } from "@thomasfosterau/legation-effect/internal";
import * as Sql from "./Sql.js";
import type * as SqlBackend from "./SqlBackend.js";

/** Configuration for {@link make}. */
export interface PollingHintSourceConfig {
  readonly executor: SqlBackend.SqlExecutor;
  /** Collection → table mapping (the `SqlBackend` mapping, reused). */
  readonly tables: Readonly<Record<string, SqlBackend.TableMapping>>;
  /** Poll cadence — the bounded staleness of an out-of-band write. */
  readonly interval: Duration.Input;
  /** Collections to poll. Defaults to every key of `tables`. */
  readonly collections?: ReadonlyArray<string>;
}

// Identifier quoting only (no placeholders in the detector), and both dialects
// quote identically, so the sqlite dialect's quoter suffices.
const quote = Sql.sqlite.quote;

/**
 * The cheap change-detector query for a table: count plus (if a version column
 * is mapped) its running maximum.
 */
const detectorQuery = (mapping: SqlBackend.TableMapping): Sql.SqlFragment => {
  const table = quote(mapping.table);
  return mapping.versionColumn !== undefined
    ? {
        text: `SELECT COUNT(*) AS n, MAX(${quote(mapping.versionColumn)}) AS v FROM ${table}`,
        params: [],
      }
    : { text: `SELECT COUNT(*) AS n FROM ${table}`, params: [] };
};

/** Collapse a detector row to a comparable signature `${count}|${maxVersion}`. */
const signatureOf = (rows: ReadonlyArray<SqlBackend.SqlRow>): string => {
  const row = rows[0] ?? {};
  const version = row.v === undefined || row.v === null ? "" : String(row.v);
  return `${String(row.n ?? 0)}|${version}`;
};

/**
 * A `HintSource` that polls each mapped table for a cheap change detector and publishes a hint
 * when a collection changes out of band.
 */
export const make = (config: PollingHintSourceConfig): HintSource.HintSource => {
  const collections = config.collections ?? Object.keys(config.tables);

  // Current detector signature for a collection, or undefined when it has no
  // table mapping (nothing to poll).
  const signatureFor = (collection: string): Effect.Effect<string | undefined, BackendError> => {
    const mapping = config.tables[collection];
    if (mapping === undefined) return Effect.succeed(undefined);
    return config.executor.query(detectorQuery(mapping)).pipe(Effect.map(signatureOf));
  };

  // One poll: read every collection's detector, publish a value-less hint for
  // each whose signature moved since the last poll (batched into one publish),
  // and remember the new signatures. The first poll only establishes the
  // baseline — a collection not yet in `state` never emits a hint.
  const tick = (
    bus: InvalidationBus.InvalidationBus,
    state: Ref.Ref<Map<string, string>>
  ): Effect.Effect<void, BackendError> =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(state);
      const next = new Map(previous);
      const changed: Array<Backend.ChangeHint> = [];
      for (const collection of collections) {
        const signature = yield* signatureFor(collection);
        if (signature === undefined) continue;
        if (previous.has(collection) && previous.get(collection) !== signature) {
          changed.push({ collection, ids: [] });
        }
        next.set(collection, signature);
      }
      yield* Ref.set(state, next);
      yield* bus.publish(changed);
    });

  return {
    run: Effect.flatMap(InvalidationBus.InvalidationBus, (bus) =>
      Effect.gen(function* () {
        // Per-run baseline: each fork starts fresh, so no spurious hint fires
        // for the state a previous run already saw.
        const state = yield* Ref.make(new Map<string, string>());
        yield* Effect.forkScoped(
          // A transient query error just skips this tick — the next poll (and
          // the interval pull) recovers; poke is never a correctness path.
          tick(bus, state).pipe(
            Effect.catch(() => Effect.void),
            Effect.repeat(Schedule.spaced(config.interval))
          )
        );
      })
    ),
  };
};
