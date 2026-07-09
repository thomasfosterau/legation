/**
 * ClientEngine.observeChanges / Mirror.observeChanges (#115): row-level
 * enter/update/exit deltas over a subset's live window, batched per
 * view-step. Anchored to `observeSubset`'s existing Patch/Rebuild/gap-collapse
 * machinery (`backpressure.test.ts`, `incremental.test.ts`) so these tests
 * exercise the same three paths at the delta level:
 *
 * - an empty-journal pull applies a `Patch` → a diffed batch (enter/update/exit);
 * - a local mutation (or any overlay-shifting change) is a `Rebuild` → a
 *   `reset` marker + fresh `enter`s;
 * - a dropped change (bounded hub under pressure) collapses into a `Rebuild`
 *   too, so it also resets rather than silently losing a delta.
 *
 * `Mirror.observeChanges` has no incremental `LiveView`: it diffs consecutive
 * whole-page `MirrorUpdate`s, so its own suite checks the same three
 * semantics land correctly from page diffing alone.
 *
 * Timing rules, both load-bearing:
 * - `Effect.forkScoped` schedules a fiber but does not preempt — the forking
 *   fiber keeps running until it hits a genuine async boundary. A collector
 *   forked right before a synchronous `mutate` call may not even reach its
 *   `PubSub.subscribe` until that boundary, by which point the mutate's one
 *   and only change has already been published and lost (no replay). So
 *   every collector here is followed by one real `settle` *before* the first
 *   write it must observe — not to "wait long enough", but to hand control
 *   back to the scheduler at all.
 * - Everything after that first synchronization point polls via `eventually`
 *   rather than guessing a fixed duration, since CI's scheduling variance
 *   makes a fixed sleep an unreliable proxy for "has this propagated yet".
 *
 * The Rebuild-path assertions fold whatever batches actually arrive
 * (`foldBatches`) rather than assuming exactly one: `ViewChange.Rebuild` is
 * documented as the conservative "the overlay could have shifted any row"
 * fallback, not a promise of one-mutation-one-batch, so the property under
 * test is "resets before re-entering, and the fold matches the engine's own
 * query" — robust to how many view-steps a given host/scheduler happens to
 * split the change into.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as MirrorModule from "../Mirror.js";
import * as Mutator from "../Mutator.js";
import type * as RowChange from "../RowChange.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
  {
    mutator: Mutator.make("todo/remove", Schema.Unknown),
    local: (args, writer) => writer.del("todos", (args as { id: string }).id),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
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

const makeClient = (handler: ServerHandler, group: string, changeHubCapacity?: number) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, group);
    return yield* ClientEngineModule.make({
      clientId: group,
      clientGroupId: group,
      mutators,
      ...(changeHubCapacity === undefined ? {} : { changeHubCapacity }),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const todos = Subset.make({ collection: "todos" });

/** Real timers, independent of the test clock (matches backpressure.test.ts). */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/**
 * The mandatory yield after forking a collector: hands control back to the
 * scheduler so the forked fiber reaches its `PubSub.subscribe` before any
 * subsequent write. Not a "hope it's enough" guess — any real async boundary
 * does this — just generous for CI's scheduling variance.
 */
const settle = sleepReal(300);

/** Fold a sequence of change batches into a plain `id -> value` map. */
const foldBatches = (
  batches: ReadonlyArray<ReadonlyArray<RowChange.RowChange<ClientEngineModule.LocalRow>>>
): Map<string, unknown> => {
  const folded = new Map<string, unknown>();
  for (const batch of batches) {
    for (const change of batch) {
      if (change._tag === "reset") folded.clear();
      else if (change._tag === "enter" || change._tag === "update") {
        folded.set(change.row.id, change.row.value);
      } else if (change._tag === "exit") folded.delete(change.id);
    }
  }
  return folded;
};

/** Poll until `read` passes `until`, bounded — never a fixed-duration guess. */
const eventually = <A, E>(read: Effect.Effect<A, E>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read.pipe(Effect.orDie);
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

/** Fork a collector and settle once, so its subscription is guaranteed live. */
const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<Array<A>>([]);
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (b) => Ref.update(batches, (a) => [...a, b])).pipe(Effect.ignore)
    );
    yield* settle;
    return batches;
  });

describe("ClientEngine.observeChanges", () => {
  it("Patch path: enter, then update, then exit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");
        yield* reader.subscribe(todos);

        const batches = yield* collect(reader.observeChanges(todos));
        expect(yield* Ref.get(batches)).toEqual([]); // includeInitial defaults to false

        yield* writer.mutate("todo/set", { id: "1", title: "first" });
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(Ref.get(batches), (seen) => seen.length === 1);

        yield* writer.mutate("todo/set", { id: "1", title: "second" });
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(Ref.get(batches), (seen) => seen.length === 2);

        yield* writer.mutate("todo/remove", { id: "1" });
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(Ref.get(batches), (seen) => seen.length === 3);

        const seen = yield* Ref.get(batches);
        expect(seen[0]).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "first" } } },
        ]);
        expect(seen[1]).toEqual([
          {
            _tag: "update",
            row: { id: "1", value: { id: "1", title: "second" } },
            previous: { id: "1", value: { id: "1", title: "first" } },
          },
        ]);
        expect(seen[2]).toEqual([
          { _tag: "exit", id: "1", previous: { id: "1", value: { id: "1", title: "second" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("includeInitial emits the current window as enters, exactly once, for a late subscriber", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");
        yield* reader.subscribe(todos);

        yield* writer.mutate("todo/set", { id: "1", title: "a" });
        yield* writer.mutate("todo/set", { id: "2", title: "b" });
        yield* writer.push;
        yield* reader.pull; // rows already present before anyone observes

        const batches = yield* collect(reader.observeChanges(todos, { includeInitial: true }));
        yield* eventually(Ref.get(batches), (seen) => seen.length >= 1);

        const seen = yield* Ref.get(batches);
        expect(seen).toHaveLength(1); // one batch: the initial enters, no gap/dup
        expect(
          new Set((seen[0] ?? []).map((c) => (c._tag === "enter" ? c.row.id : undefined)))
        ).toEqual(new Set(["1", "2"]));
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("Rebuild path (a local mutation): a reset marker followed by fresh enters", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "solo");
        yield* engine.subscribe(todos);

        const batches = yield* collect(engine.observeChanges(todos));
        expect(yield* Ref.get(batches)).toEqual([]);

        yield* engine.mutate("todo/set", { id: "1", title: "optimistic" });

        // Tolerant of exactly how many view-steps the mutation is batched
        // into (a Rebuild is the fallback for "the overlay could have shifted
        // any row", not a promise of one-op-one-batch): the contract under
        // test is that a Rebuild always resets before re-entering, and that
        // folding whatever batches arrive reproduces the engine's own query.
        yield* eventually(
          Ref.get(batches).pipe(Effect.map((seen) => [...foldBatches(seen).keys()].toSorted())),
          (ids) => ids.length === 1 && ids[0] === "1"
        );

        const seen = yield* Ref.get(batches);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.some((batch) => batch[0]?._tag === "reset")).toBe(true);
        const folded = foldBatches(seen);
        expect([...folded.entries()]).toEqual([["1", { id: "1", title: "optimistic" }]]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("a seq-gap collapse resets rather than losing the dropped deltas", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "storm", 4); // small bound → forced drops
        yield* engine.subscribe(todos);

        const batches = yield* Ref.make<
          Array<ReadonlyArray<RowChange.RowChange<ClientEngineModule.LocalRow>>>
        >([]);
        const seenCount = yield* Ref.make(0);
        const release = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          Stream.runForEach(engine.observeChanges(todos), (batch) =>
            Effect.gen(function* () {
              yield* Ref.update(batches, (a) => [...a, batch]);
              const n = yield* Ref.updateAndGet(seenCount, (x) => x + 1);
              // Stall after the first live batch so the consumer's queue
              // backs up while the storm below overruns the bound —
              // deterministic overflow, mirroring backpressure.test.ts's
              // engine-change-hub test rather than hoping one occurs.
              if (n === 1) yield* Deferred.await(release);
            })
          ).pipe(Effect.ignore)
        );
        yield* settle; // let the collector subscribe before the first mutate

        yield* engine.mutate("todo/set", { id: "s0", title: "t0" }); // first live batch: stalls the consumer
        yield* eventually(Ref.get(seenCount), (n) => n === 1);

        // Storm: far more changes than the bound of 4 → the hub drops the
        // surplus while the consumer is stalled.
        yield* Effect.forEach(Array.from({ length: 30 }), (_, i) =>
          engine.mutate("todo/set", { id: `s${i + 1}`, title: `t${i + 1}` })
        );
        yield* Deferred.succeed(release, undefined);

        // A gap forces a reset; keep polling until the folded state matches
        // the engine's own query (more batches may still be draining).
        const foldedIds = Ref.get(batches).pipe(
          Effect.map((seen) => [...foldBatches(seen).keys()].toSorted())
        );
        const expectedIds = engine
          .query(todos)
          .pipe(Effect.map((rows) => rows.map((r) => r.id).toSorted()));
        yield* eventually(
          Effect.all([foldedIds, expectedIds]),
          ([folded, expected]) => JSON.stringify(folded) === JSON.stringify(expected)
        );

        const seen = yield* Ref.get(batches);
        expect(seen.some((batch) => batch[0]?._tag === "reset")).toBe(true);
      }).pipe(Effect.scoped)
    );
  }, 10000);
});

describe("Mirror.observeChanges", () => {
  const makeEngine = (handler: ServerHandler) =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-host");
      return yield* ClientEngineModule.make({
        clientId: "host",
        clientGroupId: "group-host",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
    });

  it("diffs consecutive whole-page mirror updates into enter/update/exit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeEngine(handler);
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine });
        const mirror = yield* MirrorModule.make({ channel: pair.mirror, mutators });

        const batches = yield* collect(mirror.observeChanges(todos));
        yield* mirror.subscribe(todos);
        yield* settle; // let the host register the mirror's subscription

        yield* mirror.mutate("todo/set", { id: "1", title: "first" });
        yield* eventually(
          Ref.get(batches).pipe(Effect.map((b) => b.filter((x) => x.length > 0))),
          (seen) => seen.length === 1
        );
        yield* mirror.mutate("todo/set", { id: "1", title: "second" });
        yield* eventually(
          Ref.get(batches).pipe(Effect.map((b) => b.filter((x) => x.length > 0))),
          (seen) => seen.length === 2
        );
        yield* mirror.mutate("todo/remove", { id: "1" });
        yield* eventually(
          Ref.get(batches).pipe(Effect.map((b) => b.filter((x) => x.length > 0))),
          (seen) => seen.length === 3
        );

        const seen = (yield* Ref.get(batches)).filter((b) => b.length > 0);
        const tags = seen.map((batch) => batch.map((c) => c._tag));
        expect(tags).toEqual([["enter"], ["update"], ["exit"]]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("includeInitial emits current rows as enters for a late subscriber", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeEngine(handler);
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine });
        const mirror = yield* MirrorModule.make({ channel: pair.mirror, mutators });

        yield* mirror.subscribe(todos);
        yield* mirror.mutate("todo/set", { id: "1", title: "a" });
        yield* eventually(mirror.query(todos), (rows) => rows.length === 1);

        const batches = yield* collect(mirror.observeChanges(todos, { includeInitial: true }));
        yield* eventually(Ref.get(batches), (seen) => seen.length >= 1);

        const seen = yield* Ref.get(batches);
        expect(seen[0]).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "a" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);
});
