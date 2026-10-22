/**
 * Delta-maintained overlay benchmark (#109's acceptance-criteria scenario): a
 * burst of single-row mutates over a large collection with a handful of live
 * queries open. Before #109, every mutate invalidated the shared overlay
 * cache and forced a full journal replay (`ClientEngine.ts`'s old
 * `collectionsTouchedBy` + scoped-`Rebuild` path); now each mutate patches
 * the cached overlay in place via a tracked writer and publishes the exact
 * ops it performed, so cost is proportional to rows touched, not
 * collection size × journal length (see `overlay-delta-scaling.test.ts` for
 * the CI-checkable assertion of that claim; this file is wall-clock only).
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept out of the coverage/test path.
 */
import { describe, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import { layerInMemory, ServerHandler } from "../Transport.js";

const ROWS = 10_000;
const MUTATIONS = 30;
const LIVE_QUERIES = 5;

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (a, w) => w.put("todos", (a as { id: string }).id, a),
  },
]);

const top = Subset.make({
  collection: "todos",
  orderBy: [{ field: "rank", direction: "asc" }],
  limit: 20,
});

// A server that acknowledges nothing (never trims): the point is to exercise
// the client-side mutate/materialize path, not the wire. The bench never pushes
// or pulls, so these are here only to satisfy the ServerHandler shape.
const noopHandler: ServerHandler = {
  handlePush: () => Effect.succeed({ lastMutationIds: {} }),
  handlePull: () => Effect.succeed({ patch: [], cookie: "c", lastMutationIds: {} }),
  handleRead: () => Effect.succeed({ rows: [] }),
  pokes: () => Stream.empty,
};

const seed = (engine: ClientEngineModule.ClientEngine) =>
  Effect.forEach(
    Array.from({ length: ROWS }, (_, i) => i),
    (i) => engine.mutate("todo/set", { id: `r${i}`, rank: i }),
    { discard: true }
  );

const scenario = Effect.gen(function* () {
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* ClientEngineModule.make({
    clientId: "bench",
    clientGroupId: "bench",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provide(layerInMemory("bench")),
    Effect.provideService(ServerHandler, noopHandler)
  );
  yield* seed(engine);
  const seen = yield* Ref.make(0);
  yield* Effect.forEach(Array.from({ length: LIVE_QUERIES }), () =>
    Effect.forkScoped(Stream.runForEach(engine.observe(top), () => Ref.update(seen, (n) => n + 1)))
  );
  // The burst: each mutate now costs a `trackedWriter` run over the one row
  // it touches (patched onto the already-warm cache) instead of a full
  // replay of the growing journal — this is the scenario #109 targets.
  yield* Effect.forEach(
    Array.from({ length: MUTATIONS }, (_, i) => i),
    (i) => engine.mutate("todo/set", { id: `r${i}`, rank: i }),
    { discard: true }
  );
});

describe("delta-maintained overlay (#109)", () => {
  test(`${MUTATIONS} mutates over ${ROWS} rows with ${LIVE_QUERIES} live queries`, async ({
    bench,
  }) => {
    await bench(`${MUTATIONS} mutates over ${ROWS} rows with ${LIVE_QUERIES} live queries`, async () => {
      await Effect.runPromise(scenario.pipe(Effect.scoped));
    }).run({ time: 1000 });
  });
});
