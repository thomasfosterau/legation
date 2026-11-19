/**
 * Incremental-aggregate benchmark (#110): three live aggregates (`Count`,
 * `Sum`, and a grouped `Count`) held open over a 10k-row collection, then
 * single-row churn — each churn is a mutate + push + pull round trip against
 * a real server, so it lands as exactly one `Put` in a `Patch` (the
 * incremental fold's unit of work, replacing the old full-page refold).
 *
 * The 10k-row seed is done once at module load (a bulk push of that many
 * pending mutations dominates startup, ~5-6s — unrelated to what's being
 * measured); each bench then times one steady-state churn against the
 * already-seeded, already-observed collection.
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept out of the coverage/test path.
 */
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Aggregate from "../Aggregate.js";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { layerInMemory, ServerHandler } from "../Transport.js";

const ROWS = 10_000;

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("row/set", Schema.Unknown),
    local: (a, w) => w.put("rows", (a as { id: string }).id, a),
  },
]);

const allRows = Subset.make({ collection: "rows" });

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make({
    "row/set": (args, writer) =>
      Effect.asVoid(writer.put("rows", (args as { id: string }).id, args)),
  });
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ rows: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

// The seeded engine is built inside the test, in the test's scope (`SyncServer.make` and the engine
// need one), so the 10k-row seed happens once and only the timed churn repeats per iteration.
describe("incremental aggregates (#110)", () => {
  // Live clock: the bench measures wall-clock time.
  it.live(
    `single-row churn over ${ROWS} rows (Count + Sum + grouped Count live)`,
    ({ bench }) =>
      Effect.gen(function* () {
        const server = yield* makeServer;
        const store = yield* ClientStoreModule.makeMemory;
        const transport = yield* Layer.build(
          layerInMemory("bench").pipe(Layer.provide(Layer.succeed(ServerHandler)(server)))
        );
        const engine = yield* ClientEngineModule.make({
          clientId: "bench",
          clientGroupId: "bench",
          mutators,
        }).pipe(Effect.provideService(ClientStore, store), Effect.provideContext(transport));

        yield* Effect.forEach(
          Array.from({ length: ROWS }, (_, i) => i),
          (i) => engine.mutate("row/set", { id: `r${i}`, n: i, team: i % 5 }),
          { concurrency: 1, discard: true }
        );
        yield* engine.push;
        yield* engine.pull; // confirms the seed, so churn starts from an empty journal

        // Hold three live aggregates open (forked into the test's scope), so every churn below re-triggers
        // all three incremental folds.
        yield* Effect.forkScoped(
          Stream.runForEach(engine.observeAggregate(allRows, Aggregate.count), () => Effect.void)
        );
        yield* Effect.forkScoped(
          Stream.runForEach(engine.observeAggregate(allRows, Aggregate.sum("n")), () => Effect.void)
        );
        yield* Effect.forkScoped(
          Stream.runForEach(
            engine.observeAggregateGrouped(allRows, Aggregate.count, "team"),
            () => Effect.void
          )
        );

        const run = Effect.runPromiseWith(yield* Effect.context());
        // A steady-state single-row churn against the seeded, already-observed
        // collection: mutate + push (acknowledged by the real server) + pull, so it
        // arrives as exactly one `Put` in a `Patch`.
        let churnCounter = ROWS;
        const churnOnce = () => {
          churnCounter += 1;
          const i = churnCounter % ROWS;
          return run(
            engine
              .mutate("row/set", { id: `r${i}`, n: churnCounter, team: churnCounter % 5 })
              .pipe(Effect.andThen(engine.push), Effect.andThen(engine.pull))
          );
        };
        yield* Effect.tryPromise(() =>
          bench(`single-row churn over ${ROWS} rows (Count + Sum + grouped Count live)`, async () => {
            await churnOnce();
          }).run()
        ).pipe(Effect.orDie);
      }),
    120_000
  );
});
