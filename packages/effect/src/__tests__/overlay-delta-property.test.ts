/**
 * Delta-maintained optimistic overlay property test (#109): the view an
 * observer sees — confirmed rows plus the overlay deltas `mutate`/push/pull
 * publish — must equal one materialized from scratch (confirmed rows with
 * the pending journal replayed on top), for every interleaving of
 * mutate/push (ack or permanent rejection)/pull. `engine.query` reads the
 * same cache `mutate` now patches in place (rather than invalidates), so
 * comparing it against an independently-reimplemented "from scratch"
 * materialization exercises the cache-patch path directly; a live `observe`
 * stream additionally exercises the `LiveView`-folding-from-`Patch`-ops path.
 *
 * A seeded PRNG (not `fast-check`, not a project dependency) drives
 * reproducible randomized interleavings across many seeds.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref, Schema, Scope, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface PutArgs {
  readonly id: string;
  readonly value: number;
}
interface IdArgs {
  readonly id: string;
}

const asPut = (args: unknown) => args as PutArgs;
const asId = (args: unknown) => args as IdArgs;

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/put", Schema.Unknown),
    local: (args, writer) => writer.put("todos", asPut(args).id, asPut(args).value),
  },
  {
    mutator: Mutator.make("todo/del", Schema.Unknown),
    local: (args, writer) => writer.del("todos", asId(args).id),
  },
  {
    // Read-modify-write: exercises `writer.get` through the tracked-write path.
    mutator: Mutator.make("todo/bump", Schema.Unknown),
    local: (args, writer) =>
      writer
        .get("todos", asId(args).id)
        .pipe(
          Effect.flatMap((current) =>
            writer.put("todos", asId(args).id, ((current as number | undefined) ?? 0) + 1)
          )
        ),
  },
  {
    // Applies optimistically like `todo/put`, but the backend always
    // permanently rejects it — exercises the reject/drop-the-overlay path.
    mutator: Mutator.make("todo/reject", Schema.Unknown),
    local: (args, writer) => writer.put("todos", asPut(args).id, asPut(args).value),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/put": (args, writer) =>
    Effect.asVoid(writer.put("todos", asPut(args).id, asPut(args).value)),
  "todo/del": (args, writer) => Effect.asVoid(writer.del("todos", asId(args).id)),
  "todo/bump": (args, writer) =>
    writer
      .get("todos", asId(args).id)
      .pipe(
        Effect.flatMap((current) =>
          writer.put("todos", asId(args).id, ((current as number | undefined) ?? 0) + 1)
        )
      ),
  "todo/reject": () => Effect.fail(new MutationRejected({ reason: "property test rejection" })),
};

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeEngine = (handler: ServerHandler, store: ClientStore, group: string) =>
  makeInMemory(handler, group).pipe(
    Effect.flatMap((transport) =>
      ClientEngineModule.make({
        clientId: group,
        clientGroupId: group,
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      )
    )
  );

const allTodos = Subset.make({ collection: "todos" });

// Deterministic PRNG (mulberry32) — not a project dependency, just enough for
// reproducible randomized interleavings across many seeds.
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Step =
  | { readonly kind: "put"; readonly id: string; readonly value: number }
  | { readonly kind: "del"; readonly id: string }
  | { readonly kind: "bump"; readonly id: string }
  | { readonly kind: "reject"; readonly id: string; readonly value: number }
  | { readonly kind: "push" }
  | { readonly kind: "pull" };

const randomStep = (rng: () => number, ids: ReadonlyArray<string>): Step => {
  const r = rng();
  const id = ids[Math.floor(rng() * ids.length)]!;
  const value = Math.floor(rng() * 1000);
  if (r < 0.3) return { kind: "put", id, value };
  if (r < 0.45) return { kind: "del", id };
  if (r < 0.6) return { kind: "bump", id };
  if (r < 0.7) return { kind: "reject", id, value };
  if (r < 0.85) return { kind: "push" };
  return { kind: "pull" };
};

const runStep = (
  engine: ClientEngineModule.ClientEngine,
  step: Step
): Effect.Effect<void, unknown> => {
  switch (step.kind) {
    case "put":
      return engine.mutate("todo/put", { id: step.id, value: step.value });
    case "del":
      return engine.mutate("todo/del", { id: step.id });
    case "bump":
      return engine.mutate("todo/bump", { id: step.id });
    case "reject":
      return engine.mutate("todo/reject", { id: step.id, value: step.value });
    case "push":
      return engine.push;
    case "pull":
      return engine.pull;
  }
};

// Independently re-derives "confirmed rows + pending journal replayed on
// top" straight from the public `ClientStore` surface and the mutator
// registry's local handlers — deliberately not calling into
// `ClientEngine`'s private `computeOverlay`, so it is a genuine oracle for
// what the engine's delta-maintained cache should equal.
const referenceOverlay = (store: ClientStore): Effect.Effect<Map<string, unknown>, unknown> =>
  Effect.gen(function* () {
    const rows = new Map<string, unknown>();
    for (const row of yield* store.listRows("todos")) rows.set(row.id, row.value);
    const writer = {
      put: (_collection: string, id: string, value: unknown) =>
        Effect.sync(() => rows.set(id, value)),
      del: (_collection: string, id: string) => Effect.sync(() => rows.delete(id)),
      get: (_collection: string, id: string) => Effect.sync(() => rows.get(id)),
    };
    for (const mutation of yield* store.pendingMutations) {
      const handler = mutators.handlers.get(mutation.mutator);
      if (handler === undefined) continue;
      yield* handler(mutation.args, writer);
    }
    return rows;
  });

const byId = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

const sortRows = (rows: ReadonlyArray<{ readonly id: string; readonly value: unknown }>) =>
  rows.map((r) => [r.id, r.value] as const).toSorted(byId);

const sortMap = (map: Map<string, unknown>) => [...map.entries()].toSorted(byId);

const SEEDS = 15;
const STEPS_PER_SEED = 25;
const IDS = ["a", "b", "c", "d"];

describe("optimistic overlay delta-maintenance property (#109)", () => {
  it.effect(
    `the cache (via engine.query) matches a from-scratch materialization after every step, across ${SEEDS} randomized mutate/push/pull/reject interleavings`,
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const rng = mulberry32(seed * 7919);
          const handler = yield* makeServer;
          const store = yield* ClientStoreModule.makeMemory;
          const engine = yield* makeEngine(handler, store, `seed-${seed}`);
          yield* engine.subscribe(allTodos);

          for (let step = 0; step < STEPS_PER_SEED; step++) {
            yield* runStep(engine, randomStep(rng, IDS));
            const actual = sortRows(yield* engine.query(allTodos));
            const expected = sortMap(yield* referenceOverlay(store));
            expect(actual, `seed ${seed}, step ${step}`).toEqual(expected);
          }
        }
      })
  );

  // Real clock: `observe`'s changes flow through the change PubSub on a
  // background fibre, so this needs `it.live` + a settle window, mirroring
  // `write-ivm.test.ts`.
  it.live(
    "an observer's incrementally-folded LiveView matches the from-scratch materialization after a randomized run",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 5; seed++) {
          const rng = mulberry32(seed * 104729);
          const handler = yield* makeServer;
          const store = yield* ClientStoreModule.makeMemory;
          const engine = yield* makeEngine(handler, store, `observer-seed-${seed}`);
          yield* engine.subscribe(allTodos);

          const latest = yield* Ref.make<ReadonlyArray<{ id: string; value: unknown }>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(engine.observe(allTodos), (rows) => Ref.set(latest, rows))
          );
          yield* Effect.sleep(Duration.millis(20));

          for (let step = 0; step < 40; step++) {
            yield* runStep(engine, randomStep(rng, IDS));
          }
          yield* Effect.sleep(Duration.millis(80));

          const observed = sortRows(yield* Ref.get(latest));
          const queried = sortRows(yield* engine.query(allTodos));
          const reference = sortMap(yield* referenceOverlay(store));
          expect(queried, `seed ${seed}`).toEqual(reference);
          expect(observed, `seed ${seed}`).toEqual(reference);
        }
      })
  );
});
