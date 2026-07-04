/**
 * Tab-mirror backpressure (#44): the mirror's change hub is bounded, so a
 * stalled tab observer cannot grow its queue without limit. On resume it
 * refreshes from the always-current `rows` Ref, so the newest rows are never
 * lost even when subset keys were dropped — and a forced refresh is counted in
 * `legation_mirror_refreshes_total`. Wiring mirrors `tab-mirror.test.ts`;
 * timing-sensitive assertions poll with real timers.
 */
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@legation/effect";
import {
  ClientEngine,
  Cvr,
  EngineHost,
  InvalidationBus,
  MirrorChannel,
  Subset,
  SyncServer,
  Mirror,
  Telemetry,
} from "@legation/effect/internal";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Metric, Ref, Schema, Stream } from "effect";

const TodoArgs = Schema.Struct({ id: Schema.String, title: Schema.String });
type Todo = typeof TodoArgs.Type;

const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

const allTodos = Subset.make({ collection: "todos" });

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return engine;
});

describe("Mirror backpressure (#44)", () => {
  it.live("a stalled tab observer bounds its queue and refreshes to latest rows", () =>
    Effect.gen(function* () {
      const engine = yield* makeEngine;
      const { host, mirror: mirrorChannel } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      // Small bound → a burst of mirror updates overruns it, forcing drops.
      const mirror = yield* Mirror.make({ channel: mirrorChannel, mutators, changeHubCapacity: 4 });
      yield* mirror.subscribe(allTodos);

      const observed = yield* Ref.make<Array<number>>([]);
      const seen = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(mirror.observe(allTodos), (rows) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(seen, (x) => x + 1);
            yield* Ref.update(observed, (a) => [...a, rows.length]);
            // Stall after the first live update, once subscribed to the hub.
            if (n === 2) yield* Deferred.await(release);
          })
        )
      );
      yield* eventually(Ref.get(seen), (n) => n >= 1); // initial page
      yield* sleepReal(30); // hub subscription established

      yield* engine.mutate("todo/set", { id: "m0", title: "m0" }); // first live update
      yield* eventually(Ref.get(seen), (n) => n === 2); // observer stalled

      const before = (yield* Metric.value(Telemetry.mirrorRefreshesTotal)).count;
      // Storm: far more updates than the bound of 4. Wait for them to propagate
      // through the host→tab pipeline into the (still-stalled) hub, so it
      // genuinely overflows and drops keys rather than the observer keeping pace.
      yield* Effect.forEach(Array.from({ length: 30 }), (_, i) =>
        engine.mutate("todo/set", { id: `s${i}`, title: `s${i}` })
      );
      yield* eventually(mirror.query(allTodos), (rows) => rows.length === 31); // all in the Ref
      yield* sleepReal(50); // let the surplus keys hit the bounded hub and drop
      yield* Deferred.succeed(release, undefined);
      // Late updates after the drain reveal the seq gap → forced refresh. Spread
      // them so at least one lands after the observer has caught up on the four
      // buffered keys (the rest were dropped), exposing the jump in seq.
      for (let i = 0; i < 6; i++) {
        yield* sleepReal(25);
        yield* engine.mutate("todo/set", { id: `final${i}`, title: `final${i}` });
      }

      // The mirror's Ref holds every row, so a resumed read converges to all 37
      // (m0 + 30 storm + 6 late).
      const latest = yield* eventually(mirror.query(allTodos), (rows) => rows.length === 37);
      expect(latest.length).toBe(37);
      // The observer eventually emits the full row set (lossless on resume).
      yield* eventually(Ref.get(observed), (all) => all.at(-1) === 37);
      const after = (yield* Metric.value(Telemetry.mirrorRefreshesTotal)).count;
      expect(after).toBeGreaterThan(before); // a dropped key forced a refresh
    })
  );
});
