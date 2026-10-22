/**
 * Write-path IVM benchmark (#39): a burst of single-row mutates over a large
 * collection with K live-query observers. Measures the cost of the mutate path
 * with collection-scoped rebuilds + the shared overlay cache against a K that
 * would, without them, force K full journal replays per change.
 *
 * Named `*.bench.ts` so `vitest run` (test mode) ignores it; run with
 * `bun run bench` (`vitest bench`). Kept out of the coverage/test path.
 */
import { describe, test } from "vite-plus/test";
import { Effect, Ref, Schema, Stream } from "effect";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

const ROWS = 10_000;
const MUTATIONS = 30;
const OBSERVERS = 20;

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
  const transport = yield* makeInMemory(noopHandler, "bench");
  const engine = yield* ClientEngineModule.make({
    clientId: "bench",
    clientGroupId: "bench",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );
  yield* seed(engine);
  const seen = yield* Ref.make(0);
  yield* Effect.forEach(Array.from({ length: OBSERVERS }), () =>
    Effect.forkScoped(Stream.runForEach(engine.observe(top), () => Ref.update(seen, (n) => n + 1)))
  );
  yield* Effect.forEach(
    Array.from({ length: MUTATIONS }, (_, i) => i),
    (i) => engine.mutate("todo/set", { id: `r${i}`, rank: i }),
    { discard: true }
  );
});

describe("write-path IVM", () => {
  test(`${MUTATIONS} mutates over ${ROWS} rows with ${OBSERVERS} observers`, async ({ bench }) => {
    await bench(`${MUTATIONS} mutates over ${ROWS} rows with ${OBSERVERS} observers`, async () => {
      await Effect.runPromise(scenario.pipe(Effect.scoped));
    }).run({ time: 1000 });
  });
});
