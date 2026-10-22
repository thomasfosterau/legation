/**
 * ClientEngine.observeChanges / Mirror.observeChanges (#115): row-level
 * enter/update/exit deltas over a subset's live window, batched per
 * view-step. Anchored to `observeSubset`'s existing Patch/Rebuild/gap-collapse
 * machinery (`backpressure.test.ts`, `incremental.test.ts`) so these tests
 * exercise the same three paths at the delta level:
 *
 * - an empty-journal pull, or a plain local mutation (#109 tracks a
 *   mutator's local handler directly onto the cached overlay and publishes
 *   exactly what it did), applies a `Patch` → a diffed batch (enter/update/exit);
 * - a pull that races a still-pending mutation — or any other change the
 *   overlay could have shifted in a way that isn't tracked precisely (an
 *   unknown mutator, a `Clear`) — is a `Rebuild` → a `reset` marker + fresh
 *   `enter`s;
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
 * `LiveView` rows carry a stable `position` (fractional index, #112), and
 * `enter`/`update`/`move` now surface it on the `RowChange` itself (since
 * `LocalRow`'s type doesn't expose `row.position`, unlike the underlying
 * runtime object) — see `row-change.test.ts` for position/move coverage.
 * `stripPositions` drops it here so these assertions stay focused on
 * membership/value, the same contract before #112's position keys were
 * surfaced.
 */
import { describe, expect, it } from "vite-plus/test";
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

interface User {
  readonly id: string;
  readonly name: string;
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
  {
    mutator: Mutator.make("user/set", Schema.Unknown),
    local: (args, writer) => writer.put("users", (args as User).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
  "user/set": (args, writer) => Effect.asVoid(writer.put("users", (args as User).id, args)),
};

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll, users: Authorization.allowAll })
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
const users = Subset.make({ collection: "users" });

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

/**
 * `LiveView`-backed rows (#112) carry a stable `position` (fractional index)
 * at runtime alongside `id`/`value`, which `LocalRow`'s public type doesn't
 * expose. These tests assert on `id`/`value` only — `position` isn't part of
 * `observeChanges`'s current contract (a natural follow-up now that stable
 * positions exist, tracked separately from this feature).
 */
const idValue = (row: { readonly id: string; readonly value: unknown }) => ({
  id: row.id,
  value: row.value,
});
const stripPositions = (batch: ReadonlyArray<RowChange.RowChange<ClientEngineModule.LocalRow>>) =>
  batch.map((change) => {
    switch (change._tag) {
      case "exit":
        return { _tag: "exit" as const, id: change.id, previous: idValue(change.previous) };
      case "update":
        return {
          _tag: "update" as const,
          row: idValue(change.row),
          previous: idValue(change.previous),
        };
      case "enter":
        return { _tag: "enter" as const, row: idValue(change.row) };
      case "move":
        return { _tag: "move" as const, row: idValue(change.row) };
      case "reset":
        return change;
    }
  });

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
        expect(stripPositions(seen[0]!)).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "first" } } },
        ]);
        expect(stripPositions(seen[1]!)).toEqual([
          {
            _tag: "update",
            row: { id: "1", value: { id: "1", title: "second" } },
            previous: { id: "1", value: { id: "1", title: "first" } },
          },
        ]);
        expect(stripPositions(seen[2]!)).toEqual([
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

  it("a local mutation produces a precise Patch enter (#109's delta-maintained overlay)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "solo");
        yield* engine.subscribe(todos);

        const batches = yield* collect(engine.observeChanges(todos));
        expect(yield* Ref.get(batches)).toEqual([]);

        yield* engine.mutate("todo/set", { id: "1", title: "optimistic" });
        yield* eventually(Ref.get(batches), (seen) => seen.length === 1);

        // #109 tracks a mutator's local handler directly onto the cached
        // overlay and publishes exactly what it did as a Patch, rather than
        // invalidating the cache and forcing a full Rebuild — so a plain
        // mutate is a precise enter, the same shape a confirmed-row Patch
        // from a pull would produce (see the Patch-path test above).
        const seen = yield* Ref.get(batches);
        expect(stripPositions(seen[0]!)).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "optimistic" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("Rebuild path (a pull racing a pending mutation): a reset marker followed by fresh enters", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer2");
        const reader = yield* makeClient(handler, "reader2");
        yield* reader.subscribe(todos);

        yield* writer.mutate("todo/set", { id: "1", title: "from-server" });
        yield* writer.push;

        const batches = yield* collect(reader.observeChanges(todos));
        expect(yield* Ref.get(batches)).toEqual([]);

        // A local, unpushed mutation leaves the reader with a pending
        // journal entry — its own Patch enter is the first batch.
        yield* reader.mutate("todo/set", { id: "2", title: "optimistic" });
        yield* eventually(Ref.get(batches), (seen) => seen.length === 1);

        // Pulling while a mutation is still pending can't be diffed
        // precisely (rebase could shift any row the patch or the pending
        // mutation touches), so `applyPull` falls back to a Rebuild scoped
        // to the union — the conservative "the overlay could have shifted
        // any row" fallback `observeChanges` documents.
        yield* reader.pull;
        yield* eventually(Ref.get(batches), (seen) => seen.length === 2);

        const seen = yield* Ref.get(batches);
        expect(seen[1]?.[0]).toEqual({ _tag: "reset" });
        const entered = new Set(
          stripPositions(seen[1]!)
            .slice(1)
            .map((c) => (c._tag === "enter" ? c.row.id : undefined))
        );
        expect(entered).toEqual(new Set(["1", "2"])); // both the pulled row and the still-pending one
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("#133: an observer of an untouched collection sees no spurious reset under a scoped rebuild", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer3");
        const reader = yield* makeClient(handler, "reader3");
        yield* reader.subscribe(todos);
        yield* reader.subscribe(users);

        const todoBatches = yield* collect(reader.observeChanges(todos));
        const userBatches = yield* collect(reader.observeChanges(users));
        expect(yield* Ref.get(todoBatches)).toEqual([]);
        expect(yield* Ref.get(userBatches)).toEqual([]);

        // A pending mutation on "todos" only.
        yield* reader.mutate("todo/set", { id: "2", title: "optimistic" });
        yield* eventually(Ref.get(todoBatches), (seen) => seen.length === 1);

        // The writer pushes a "todos" change; the reader's pull races its own
        // still-pending "todos" mutation — `applyPull` scopes the resulting
        // Rebuild to exactly {"todos"} (touched ∪ the reader's own pending
        // mutation's collections), never the unscoped fallback. "users" is
        // outside that set, so its observer must see nothing at all — not
        // even a `reset` — for this pull.
        yield* writer.mutate("todo/set", { id: "1", title: "from-server" });
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(Ref.get(todoBatches), (seen) => seen.length === 2);

        const todoSeen = yield* Ref.get(todoBatches);
        expect(todoSeen[1]?.[0]).toEqual({ _tag: "reset" });

        // Give a spurious "users" batch every chance to arrive before
        // asserting its absence.
        yield* settle;
        expect(yield* Ref.get(userBatches)).toEqual([]);
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
        // The dropped items vanish silently — `PubSub.dropping` never tells a
        // stalled subscriber it missed anything, so without a change *after*
        // the drain the consumer just sees its buffered backlog end on a
        // contiguous seq and goes quiet, no gap ever revealed (matching
        // backpressure.test.ts's engine-change-hub test, which mutates once
        // more post-release for exactly this reason).
        yield* settle;
        yield* engine.mutate("todo/set", { id: "final", title: "final" });

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

// ─── Randomized property through the real engine stream (#133 item 5) ───────
//
// `row-change.test.ts` drives the same fold-reproduces-the-page property
// directly against `LiveView` — fast, and exhaustive over hundreds of steps.
// This drives a smaller randomized sequence through the actual
// `ClientEngine.observeChanges` stream (real Patch/Rebuild decisions, a real
// journal, real async scheduling) to confirm the property holds end-to-end,
// not only at the pure `LiveView` layer it's built on.

/** mulberry32: same tiny deterministic PRNG as `row-change.test.ts`. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const foldChangeBatches = (
  batches: ReadonlyArray<ReadonlyArray<RowChange.RowChange<ClientEngineModule.LocalRow>>>
): Map<string, unknown> => {
  const state = new Map<string, unknown>();
  for (const batch of batches) {
    for (const change of batch) {
      switch (change._tag) {
        case "reset":
          state.clear();
          break;
        case "enter":
        case "update":
          state.set(change.row.id, change.row.value);
          break;
        case "exit":
          state.delete(change.id);
          break;
        case "move":
          break;
      }
    }
  }
  return state;
};

const sortedIdValue = (state: Map<string, unknown>) =>
  [...state.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe("ClientEngine.observeChanges — randomized property through the real engine", () => {
  it("folding the real observeChanges stream matches engine.query at every step", async () => {
    const IDS = ["a", "b", "c", "d", "e"];
    for (let seed = 1; seed <= 3; seed++) {
      // eslint-disable-next-line no-await-in-loop -- each seed needs the previous engine torn down first
      await Effect.runPromise(
        Effect.gen(function* () {
          const handler = yield* makeServer;
          // A tiny change-hub bound so an occasional burst forces a real
          // seq-gap collapse, alongside the ordinary Patch/pending-pull-Rebuild
          // paths — all three real triggers, randomized together.
          const engine = yield* makeClient(handler, `prop-${seed}`, 3);
          yield* engine.subscribe(todos);

          const batches = yield* Ref.make<
            Array<ReadonlyArray<RowChange.RowChange<ClientEngineModule.LocalRow>>>
          >([]);
          yield* Effect.forkScoped(
            Stream.runForEach(engine.observeChanges(todos), (batch) =>
              Ref.update(batches, (a) => [...a, batch])
            ).pipe(Effect.ignore)
          );
          yield* settle;

          const rand = mulberry32(seed);
          const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(rand() * xs.length)]!;

          for (let step = 0; step < 20; step++) {
            const action = rand();
            const id = pick(IDS);
            if (action < 0.15) {
              yield* engine.mutate("todo/remove", { id });
            } else if (action < 0.35) {
              yield* engine.pull; // a pull: Rebuild only if a mutation is still pending
            } else {
              yield* engine.mutate("todo/set", { id, title: `t-${Math.floor(rand() * 5)}` });
            }
            // Bursts of rapid mutations occasionally overrun the tiny hub
            // bound above, forcing a gap-collapse — exercised by chance
            // across seeds/steps rather than a dedicated branch.

            const expected = sortedIdValue(
              new Map((yield* engine.query(todos)).map((r) => [r.id, r.value]))
            );
            // eslint-disable-next-line no-loop-func -- captures `batches` fresh each poll, not stale
            const seen = yield* eventually(Ref.get(batches), (candidate) => {
              const folded = sortedIdValue(foldChangeBatches(candidate));
              return JSON.stringify(folded) === JSON.stringify(expected);
            });
            expect(sortedIdValue(foldChangeBatches(seen))).toEqual(expected);
          }
        }).pipe(Effect.scoped)
      );
    }
  }, 20000);
});
