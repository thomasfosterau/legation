/**
 * PollingHintSource (#43): the polling source reads a cheap change-detector per
 * table on an interval and publishes a value-less `ChangeHint` for a collection
 * whose detector moved between polls — the baseline poll never emits, and an
 * unchanged detector never emits. A final integration test proves the poke
 * reaches a subscribed group through the SyncServer fan-out loop, with no
 * app-authored hint.
 *
 * Polls happen on a forked fibre on a real interval, so the suite uses
 * `it.live` (wall time) with a short interval and real-timer settles/races,
 * mirroring `fanout-matching.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import { Authorization, Backend, MemoryBackend } from "@thomasfosterau/legation-effect";
import {
  Cvr,
  HintSource,
  InvalidationBus,
  Subset,
  SyncServer,
  Telemetry,
} from "@thomasfosterau/legation-effect/internal";
import * as PollingHintSource from "../PollingHintSource.js";
import type * as SqlBackend from "../SqlBackend.js";

/** A detector reading the test drives between polls (an out-of-band write). */
interface Detector {
  n: number;
  v: string | null;
}

/**
 * An executor whose every query returns the current detector reading as a
 * single `{ n, v }` row — the shape `SELECT COUNT(*) AS n, MAX(version) AS v`
 * produces. The polling source issues only detector queries.
 */
const makeExecutor = (read: () => Detector): SqlBackend.SqlExecutor => ({
  query: () => Effect.sync(() => [{ ...read() }] as ReadonlyArray<SqlBackend.SqlRow>),
  run: () => Effect.void,
  transaction: (effect) => effect,
});

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const todos = { todos: { table: "todos", versionColumn: "version" } };

describe("PollingHintSource (#43)", () => {
  it.live("emits a value-less hint only when the version-detector moves", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      const subscription = yield* bus.subscribe;
      const detector: Detector = { n: 1, v: "a" };

      const source = PollingHintSource.make({
        executor: makeExecutor(() => detector),
        tables: todos,
        interval: "10 millis",
      });
      yield* HintSource.run(source).pipe(
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      // The baseline poll (and repeats over an unchanged detector) emit nothing.
      const baseline = yield* Effect.race(
        subscription.take.pipe(Effect.as("hint" as const)),
        sleepReal(40).pipe(Effect.as("quiet" as const))
      );
      expect(baseline).toBe("quiet");

      // An out-of-band write bumps the count and version; the next poll emits.
      detector.n = 2;
      detector.v = "b";
      const hint = yield* subscription.take;
      expect(hint).toEqual([{ collection: "todos", ids: [] }]);
    }).pipe(Effect.scoped)
  );

  it.live("detects a row-count change when no version column is mapped", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      const subscription = yield* bus.subscribe;
      const detector: Detector = { n: 1, v: null };

      const source = PollingHintSource.make({
        executor: makeExecutor(() => detector),
        tables: { todos: { table: "todos" } }, // no versionColumn — count only
        interval: "10 millis",
      });
      yield* HintSource.run(source).pipe(
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      yield* sleepReal(30); // establish the baseline
      detector.n = 2; // an insert changes the count
      const hint = yield* subscription.take;
      expect(hint).toEqual([{ collection: "todos", ids: [] }]);
    }).pipe(Effect.scoped)
  );

  it.live("an out-of-band write pokes a subscribed group with no app-authored hint", () =>
    Effect.gen(function* () {
      // A full server over an in-process bus, with a group subscribed to todos.
      const backend = yield* MemoryBackend.make({});
      const cvrStore = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(
          Authorization.AuthPolicy,
          Authorization.policy({ todos: Authorization.allowAll })
        ),
        Effect.provideService(Cvr.CvrStore, cvrStore),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );
      yield* handler.handlePull({
        clientGroupId: "g",
        cookie: undefined,
        subscriptions: [Subset.make({ collection: "todos" })],
      });

      // The polling source publishes to the same bus the server fans out from.
      const detector: Detector = { n: 1, v: "a" };
      const source = PollingHintSource.make({
        executor: makeExecutor(() => detector),
        tables: todos,
        interval: "10 millis",
      });
      yield* HintSource.run(source).pipe(
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      yield* sleepReal(30); // let the baseline settle (no poke)
      const before = (yield* Metric.value(Telemetry.pokesTotal)).count;

      // Simulate a write that bypassed every mutator (cron/admin/psql).
      detector.n = 2;
      detector.v = "b";
      yield* sleepReal(50); // one poll detects it → one hint → fan-out pokes g

      const after = (yield* Metric.value(Telemetry.pokesTotal)).count;
      expect(after - before).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.scoped)
  );
});
