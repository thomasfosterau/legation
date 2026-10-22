/**
 * Backpressure (#44): the engine's message hubs are bounded, so a stalled
 * consumer or a hint storm cannot grow a queue without limit. Each hub trades
 * an unbounded queue for a bounded, lossless-under-pressure policy:
 *
 * - the poke hub is `sliding(1)` per group (a storm collapses to one poke);
 * - the invalidation bus is bounded `dropping` (a dropped hint only delays the
 *   next pull, and is counted);
 * - the change hub is bounded `dropping` with a seq-gap → Rebuild collapse (a
 *   dropped Patch is subsumed by a Rebuild, so the view stays correct).
 *
 * Timing-sensitive cases use `it.live` (real timers) like the incremental and
 * tab-mirror suites; the bus-drop case is deterministic and uses `it.effect`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
import * as Telemetry from "../Telemetry.js";
import { ClientTransport, makeInMemory, makePokeHub, type ServerHandler } from "../Transport.js";

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { id: string }).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) =>
    Effect.asVoid(writer.put("todos", (args as { id: string }).id, args)),
};

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
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

const makeClient = (handler: ServerHandler, capacity: number) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-a");
    return yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators,
      changeHubCapacity: capacity,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const todos = Subset.make({ collection: "todos" });

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Poll until `read` passes `until`, bounded. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

describe("backpressure — poke hub", () => {
  it.live("a poke storm delivers at most one queued poke per group", () =>
    Effect.gen(function* () {
      const hub = yield* makePokeHub;
      const received = yield* Ref.make<Array<unknown>>([]);
      const release = yield* Deferred.make<void>();
      // A subscriber that takes its first poke, then blocks — so the storm hits
      // a full sliding(1) buffer and collapses to a single queued survivor.
      yield* Effect.forkScoped(
        Stream.runForEach(hub.subscribe("group-a"), (poke) =>
          Ref.update(received, (a) => [...a, poke]).pipe(Effect.andThen(Deferred.await(release)))
        )
      );
      yield* sleepReal(30); // let the subscription establish (pull pending)
      // Storm: 50 pokes in a tick. The first is taken (in-flight), the rest
      // slide over one another — one survivor remains queued.
      yield* Effect.forEach(Array.from({ length: 50 }), () => hub.publish("group-a", {}));
      yield* sleepReal(30);
      expect((yield* Ref.get(received)).length).toBe(1); // one in-flight, rest queued to one
      yield* Deferred.succeed(release, undefined);
      yield* sleepReal(30);
      // Exactly one more (the single slid survivor); no unbounded backlog.
      expect((yield* Ref.get(received)).length).toBe(2);
    }).pipe(Effect.scoped)
  );

  it.live("a late subscriber sees only the latest poke (replay 1)", () =>
    Effect.gen(function* () {
      const hub = yield* makePokeHub;
      yield* Effect.forEach(Array.from({ length: 50 }), () => hub.publish("group-a", {}));
      // Late subscriber: replay 1 delivers the most recent poke, not all 50.
      const got = yield* hub.subscribe("group-a").pipe(Stream.take(1), Stream.runCollect);
      expect(got.length).toBe(1);
    }).pipe(Effect.scoped)
  );
});

describe("backpressure — invalidation bus", () => {
  it.effect("increments the dropped-hint metric when a bounded bus overflows", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcessWith({ capacity: 2 });
      // Hold a subscription open but never take: publishes past capacity drop.
      yield* bus.subscribe;
      const before = (yield* Metric.value(Telemetry.hintsDroppedTotal)).count;
      yield* Effect.forEach(Array.from({ length: 20 }), (_, i) =>
        bus.publish([{ collection: "todos", ids: [`r${i}`] }])
      );
      const after = (yield* Metric.value(Telemetry.hintsDroppedTotal)).count;
      expect(after).toBeGreaterThan(before);
    }).pipe(Effect.scoped)
  );
});

describe("backpressure — engine change hub", () => {
  it.live("a stalled observer bounds its queue and resumes with a correct Rebuild", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const engine = yield* makeClient(handler, 4); // small bound → forced drops

      const pages = yield* Ref.make<Array<ReadonlyArray<string>>>([]);
      const seen = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(engine.observe(todos), (rows) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(seen, (x) => x + 1);
            yield* Ref.update(pages, (a) => [
              ...a,
              rows.map((r) => (r.value as { id: string }).id),
            ]);
            // Block after the first LIVE change (n === 2) so the subscription is
            // established, then stall while the storm overruns the bound.
            if (n === 2) yield* Deferred.await(release);
          })
        )
      );
      yield* eventually(Ref.get(seen), (n) => n === 1); // initial empty page
      yield* sleepReal(30); // subscription to the change hub established

      yield* engine.mutate("todo/set", { id: "m0" }); // first live change
      yield* eventually(Ref.get(seen), (n) => n === 2); // observer now stalled

      const before = (yield* Metric.value(Telemetry.changeCollapsesTotal)).count;
      // Storm: far more changes than the bound of 4 → the hub drops the surplus.
      yield* Effect.forEach(Array.from({ length: 30 }), (_, i) =>
        engine.mutate("todo/set", { id: `s${i}` })
      );
      yield* Deferred.succeed(release, undefined);
      // A change after the drain reveals the seq gap → collapse to a Rebuild.
      yield* sleepReal(30);
      yield* engine.mutate("todo/set", { id: "final" });

      const expected = yield* engine.query(todos);
      yield* eventually(
        Ref.get(pages),
        (all) => all.length > 0 && all[all.length - 1]!.length === expected.length
      );
      const last = (yield* Ref.get(pages)).at(-1)!;
      // The resumed view equals a fresh query — no dropped Patch was lost.
      expect(Arr.sort(last, Order.String)).toEqual(
        Arr.sort(
          expected.map((r) => (r.value as { id: string }).id),
          Order.String
        )
      );
      const after = (yield* Metric.value(Telemetry.changeCollapsesTotal)).count;
      expect(after).toBeGreaterThan(before); // a gap forced at least one Rebuild
    }).pipe(Effect.scoped)
  );
});
