/**
 * CI-checkable proof of #109's acceptance-criteria benchmark claim ("per-
 * mutation cost proportional to rows touched, not collection size × journal
 * length"): a `store.listRows` call is the one operation whose cost scales
 * with collection size (`ClientStore.listRows` reads every row of a
 * collection), so counting calls to it is a deterministic proxy for "did a
 * full replay happen." `overlay-delta.bench.ts` has the matching wall-clock
 * benchmark (30-mutation burst, 10k-row collection, 5 live queries); this
 * file asserts the same scenario costs zero further collection scans once
 * warm, which `bun run test:run` (unlike `bun run bench`) actually checks.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

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

const noopHandler: ServerHandler = {
  handlePush: () => Effect.succeed({ lastMutationIds: {} }),
  handlePull: () => Effect.succeed({ patch: [], cookie: "c", lastMutationIds: {} }),
  handleRead: () => Effect.succeed({ rows: [] }),
  pokes: () => Stream.empty,
};

// A client whose `listRows` calls are counted, so a test can prove a burst of
// mutates never re-scans the collection (mirrors `write-ivm.test.ts`).
const makeCountedClient = () =>
  Effect.gen(function* () {
    const base = yield* ClientStoreModule.makeMemory;
    const listRowsCount = yield* Ref.make(0);
    const store: ClientStore = {
      ...base,
      listRows: (collection) =>
        Ref.update(listRowsCount, (n) => n + 1).pipe(Effect.andThen(base.listRows(collection))),
    };
    const transport = yield* makeInMemory(noopHandler, "scaling");
    const engine = yield* ClientEngineModule.make({
      clientId: "scaling",
      clientGroupId: "scaling",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, listRowsCount };
  });

describe("overlay delta-maintenance scaling (#109)", () => {
  it.live(
    `a ${MUTATIONS}-mutation burst over ${ROWS} rows with ${LIVE_QUERIES} live queries costs zero further collection scans once warm`,
    () =>
      Effect.gen(function* () {
        const { engine, listRowsCount } = yield* makeCountedClient();
        yield* Effect.forEach(
          Array.from({ length: ROWS }, (_, i) => i),
          (i) => engine.mutate("todo/set", { id: `r${i}`, rank: i }),
          { discard: true }
        );
        yield* Effect.forEach(Array.from({ length: LIVE_QUERIES }), () =>
          Effect.forkScoped(Stream.runForEach(engine.observe(top), () => Effect.void))
        );
        yield* Effect.sleep(Duration.millis(50)); // let observers materialize once

        yield* Ref.set(listRowsCount, 0); // measure only the burst below

        yield* Effect.forEach(
          Array.from({ length: MUTATIONS }, (_, i) => i),
          (i) => engine.mutate("todo/set", { id: `r${i}`, rank: i }),
          { discard: true }
        );

        // Every mutate patched the already-warm cache in place (#109): no
        // mutate re-scanned the 10k-row collection, regardless of the
        // growing journal or how many live queries were watching.
        expect(yield* Ref.get(listRowsCount)).toBe(0);
      })
  );
});
