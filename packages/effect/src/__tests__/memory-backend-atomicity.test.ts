/**
 * MemoryBackend atomicity (Backend guarantee 1, issue #341): a mutation's
 * writes become visible only together with its lastMutationId bump, a
 * `BackendError` discards its writes, and a handler reads back its own staged
 * writes.
 *
 * The concurrency sections cover overlapping copies of one mutation (#346) and
 * the committed outcome a losing copy reports (#355), at the backend and
 * through a ClientEngine whose two push responses arrive in either order.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, HashMap, Option, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend, type SyncContext } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { BackendError, MutationRejected } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import type { Mutation } from "../Protocol.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

const context: SyncContext = { clientGroupId: "memory-atomicity-group" };
const clientId = "memory-atomicity-client";
const rows = "rows";

const mutation = (mutationId: number, mutator: string, args: unknown): Mutation => ({
  clientId,
  mutationId,
  mutator,
  args,
  createdAt: 0,
});

interface Args {
  readonly id: string;
  readonly n: number;
}

const argsOf = (raw: unknown): Args => raw as Args;

/** Plain sets, plus the failure and parking shapes each test needs. */
const handlersFor = (hooks: {
  readonly written: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly observed: Ref.Ref<ReadonlyArray<unknown>>;
}): Record<string, MemoryBackend.BackendHandler> => ({
  "test/set": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer.put(rows, id, { n });
  },
  // Write, then park before returning: the window a pull or evaluate can hit.
  "test/park": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(
        Effect.andThen(Deferred.succeed(hooks.written, undefined)),
        Effect.andThen(Deferred.await(hooks.release))
      );
  },
  // Write, park, then reject permanently.
  "test/park-reject": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(
        Effect.andThen(Deferred.succeed(hooks.written, undefined)),
        Effect.andThen(Deferred.await(hooks.release)),
        Effect.andThen(Effect.fail(new MutationRejected({ reason: "parked and rejected" })))
      );
  },
  // Write, then fail transiently.
  "test/fail-after-write": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer
      .put(rows, id, { n })
      .pipe(Effect.andThen(Effect.fail(new BackendError({ message: "transient after write" }))));
  },
  // Write, read it back, delete it, read again.
  "test/read-back": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return Effect.gen(function* () {
      yield* writer.put(rows, id, { n });
      const afterPut = yield* writer.get(rows, id);
      yield* writer.del(rows, id);
      const afterDel = yield* writer.get(rows, id);
      yield* Ref.set(hooks.observed, [afterPut, afterDel]);
    });
  },
});

const makeHooks = Effect.gen(function* () {
  return {
    written: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    observed: yield* Ref.make<ReadonlyArray<unknown>>([]),
  };
});

describe("MemoryBackend atomicity", () => {
  it.effect("keeps a handler's writes and its bump invisible until the mutation commits", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      const push = yield* Effect.forkChild(
        backend.applyMutations(context, [mutation(1, "test/park", { id: "a", n: 1 })])
      );
      // The handler has written and is parked before it returns.
      yield* Deferred.await(hooks.written);

      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.evaluate(context, Subset.make({ collection: rows }))).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({});

      yield* Deferred.succeed(hooks.release, undefined);
      const result = yield* Fiber.join(push);

      // After the mutation finishes, the write and the bump are both visible.
      expect(result.lastMutationIds[clientId]).toBe(1);
      const [row] = yield* backend.getRows(context, rows, ["a"]);
      expect(row?.value).toEqual({ n: 1 });
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("discards a rejected mutation's writes and bumps only after it parks", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      const push = yield* Effect.forkChild(
        backend.applyMutations(context, [mutation(1, "test/park-reject", { id: "a", n: 1 })])
      );
      yield* Deferred.await(hooks.written);

      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({});

      yield* Deferred.succeed(hooks.release, undefined);
      const result = yield* Fiber.join(push);

      expect(result.lastMutationIds[clientId]).toBe(1);
      expect(result.rejected?.map((entry) => entry.mutationId)).toEqual([1]);
      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("leaves a row unchanged and bumps nothing when a handler fails after a write", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      yield* backend.applyMutations(context, [mutation(1, "test/set", { id: "a", n: 1 })]);
      const [before] = yield* backend.getRows(context, rows, ["a"]);

      const exit = yield* Effect.exit(
        backend.applyMutations(context, [mutation(2, "test/fail-after-write", { id: "a", n: 2 })])
      );
      expect(exit._tag).toBe("Failure");

      // The failed write is gone: same value, same version, no bump.
      const [after] = yield* backend.getRows(context, rows, ["a"]);
      expect(after).toEqual(before);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });

      // The client's retry of mutation 2 then applies and bumps, with a newer version.
      const retry = yield* backend.applyMutations(context, [
        mutation(2, "test/set", { id: "a", n: 2 }),
      ]);
      expect(retry.lastMutationIds[clientId]).toBe(2);
      const [retried] = yield* backend.getRows(context, rows, ["a"]);
      expect(retried?.value).toEqual({ n: 2 });
      expect(Number(retried?.version)).toBeGreaterThan(Number(before?.version));
    })
  );

  it.effect("lets a handler read back its own staged writes and deletes", () =>
    Effect.gen(function* () {
      const hooks = yield* makeHooks;
      const backend = yield* MemoryBackend.make(handlersFor(hooks));

      yield* backend.applyMutations(context, [mutation(1, "test/read-back", { id: "a", n: 7 })]);

      expect(yield* Ref.get(hooks.observed)).toEqual([{ n: 7 }, undefined]);
      expect(yield* backend.getRows(context, rows, ["a"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );
});

/** Names of the parked copies a concurrency test drives. */
type GateName = "a" | "b" | "first" | "stale" | "fresh" | "next";

/**
 * A copy parks at `release` after it has entered its handler, so the test
 * decides when it resumes and commits.
 */
interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeGate = Effect.gen(function* () {
  return {
    entered: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  } satisfies Gate;
});

const makeGates = Effect.all({
  a: makeGate,
  b: makeGate,
  first: makeGate,
  stale: makeGate,
  fresh: makeGate,
  next: makeGate,
});

/**
 * `test/gated`: park, then read the counter and increment it, then write the
 * row. The read happens after the park, so a copy that resumes late sees
 * whatever committed while it was parked; a counter that moves twice means
 * the mutation applied twice.
 */
const gatedHandlers = (
  gates: Record<GateName, Gate>
): Record<string, MemoryBackend.BackendHandler> => ({
  "test/gated": (raw, writer) => {
    const { id, n, gate } = raw as {
      readonly id: string;
      readonly n: number;
      readonly gate: GateName;
    };
    const hook = gates[gate];
    return Effect.gen(function* () {
      yield* Deferred.succeed(hook.entered, undefined);
      yield* Deferred.await(hook.release);
      const current = (yield* writer.get(rows, "counter")) as { count: number } | undefined;
      yield* writer.put(rows, "counter", { count: (current?.count ?? 0) + 1 });
      yield* writer.put(rows, id, { n });
    });
  },
});

const gatedMutation = (mutationId: number, gate: GateName, id: string, n: number): Mutation =>
  mutation(mutationId, "test/gated", { id, n, gate });

describe("MemoryBackend concurrent applyMutations (#346)", () => {
  it.effect("applies a mutation once when two in-flight copies of it race", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates;
      const backend = yield* MemoryBackend.make(gatedHandlers(gates));

      // Both copies of (c1, 1) pass the start-of-mutation check and park.
      const copyA = yield* Effect.forkChild(
        backend.applyMutations(context, [gatedMutation(1, "a", "x", 1)])
      );
      const copyB = yield* Effect.forkChild(
        backend.applyMutations(context, [gatedMutation(1, "b", "x", 1)])
      );
      yield* Deferred.await(gates.a.entered);
      yield* Deferred.await(gates.b.entered);

      // B commits first; then A resumes holding a stale copy of the same mutation.
      yield* Deferred.succeed(gates.b.release, undefined);
      const resultB = yield* Fiber.join(copyB);
      expect(resultB.lastMutationIds[clientId]).toBe(1);
      const afterB = yield* backend.getRows(context, rows, ["x", "counter"]);
      expect(afterB.map((row) => row.value)).toEqual([{ n: 1 }, { count: 1 }]);

      yield* Deferred.succeed(gates.a.release, undefined);
      const resultA = yield* Fiber.join(copyA);

      // A's copy is a replay: the rows keep B's versions, and it reports no effects.
      expect(yield* backend.getRows(context, rows, ["x", "counter"])).toEqual(afterB);
      expect(resultA.lastMutationIds[clientId]).toBe(1);
      expect(resultA.hints).toEqual([]);
      expect(resultA.rejected).toBeUndefined();
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("does not move lastMutationIds backwards when a stale copy commits last", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates;
      const backend = yield* MemoryBackend.make(gatedHandlers(gates));

      // Mutation 1 commits, so mutation 2 passes the gap check.
      yield* Deferred.succeed(gates.first.release, undefined);
      yield* backend.applyMutations(context, [gatedMutation(1, "first", "x", 1)]);

      // Copy A of mutation 2 parks; copy B of mutation 2 and mutation 3 run to commit.
      const staleCopy = yield* Effect.forkChild(
        backend.applyMutations(context, [gatedMutation(2, "stale", "x", 2)])
      );
      yield* Deferred.await(gates.stale.entered);
      yield* Deferred.succeed(gates.fresh.release, undefined);
      yield* Deferred.succeed(gates.next.release, undefined);
      yield* backend.applyMutations(context, [gatedMutation(2, "fresh", "x", 2)]);
      const committed = yield* backend.applyMutations(context, [gatedMutation(3, "next", "x", 3)]);
      expect(committed.lastMutationIds[clientId]).toBe(3);
      const beforeStale = yield* backend.getRows(context, rows, ["x", "counter"]);
      expect(beforeStale.map((row) => row.value)).toEqual([{ n: 3 }, { count: 3 }]);

      // The stale copy of mutation 2 resumes last.
      yield* Deferred.succeed(gates.stale.release, undefined);
      const staleResult = yield* Fiber.join(staleCopy);

      // The watermark stays at 3, and the stale writes do not land over
      // mutation 3's row or bump the counter again.
      expect(staleResult.lastMutationIds[clientId]).toBe(3);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 3 });
      expect(yield* backend.getRows(context, rows, ["x", "counter"])).toEqual(beforeStale);

      // A later retry of mutation 3 is a replay and stays a no-op.
      const retry = yield* backend.applyMutations(context, [gatedMutation(3, "next", "x", 3)]);
      expect(retry.lastMutationIds[clientId]).toBe(3);
      expect(yield* backend.getRows(context, rows, ["x", "counter"])).toEqual(beforeStale);
    })
  );
});

/** The #346 handlers, plus a mutator that rejects at once and a plain set (#355). */
const outcomeHandlers = (
  gates: Record<GateName, Gate>
): Record<string, MemoryBackend.BackendHandler> => ({
  ...gatedHandlers(gates),
  "test/reject": () => Effect.fail(new MutationRejected({ reason: "forbidden" })),
  "test/set": (raw, writer) => {
    const { id, n } = argsOf(raw);
    return writer.put(rows, id, { n });
  },
});

const rejectedMutation = (mutationId: number): Mutation => mutation(mutationId, "test/reject", {});

const rejection = (mutationId: number) => ({ clientId, mutationId, reason: "forbidden" });

describe("MemoryBackend committed outcome of a copy that loses the race (#355)", () => {
  it.effect("a skipped copy of N does not stop N+1 from applying, in order", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates;
      const backend = yield* MemoryBackend.make(gatedHandlers(gates));

      // Copy A of [1, 2] parks inside mutation 1.
      const copyA = yield* Effect.forkChild(
        backend.applyMutations(context, [
          gatedMutation(1, "a", "x", 1),
          gatedMutation(2, "next", "y", 2),
        ])
      );
      yield* Deferred.await(gates.a.entered);

      // Copy B of mutation 1 commits first.
      yield* Deferred.succeed(gates.b.release, undefined);
      yield* backend.applyMutations(context, [gatedMutation(1, "b", "x", 1)]);

      // A resumes: its mutation 1 is skipped at commit, and mutation 2 still applies after it.
      yield* Deferred.succeed(gates.a.release, undefined);
      yield* Deferred.succeed(gates.next.release, undefined);
      const resultA = yield* Fiber.join(copyA);

      expect(resultA.lastMutationIds[clientId]).toBe(2);
      expect(resultA.rejected).toBeUndefined();
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 2 });
      const stored = yield* backend.getRows(context, rows, ["x", "counter", "y"]);
      expect(stored.map((row) => row.value)).toEqual([{ n: 1 }, { count: 2 }, { n: 2 }]);
      const version = (id: string) => Number(stored.find((row) => row.id === id)?.version);
      expect(version("x")).toBeLessThan(version("counter"));
      expect(version("counter")).toBeLessThan(version("y"));
    })
  );

  it.effect("a copy of a mutation committed as rejected reports the rejection", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates;
      const backend = yield* MemoryBackend.make(outcomeHandlers(gates));

      // Copy A of an applied mutation 1 parks.
      const copyA = yield* Effect.forkChild(
        backend.applyMutations(context, [gatedMutation(1, "a", "x", 1)])
      );
      yield* Deferred.await(gates.a.entered);

      // Copy B of mutation 1 is rejected, and it commits first.
      const copyB = yield* backend.applyMutations(context, [rejectedMutation(1)]);
      expect(copyB.rejected).toEqual([rejection(1)]);

      // A resumes and loses. Its response reports the committed rejection, so it agrees with B.
      yield* Deferred.succeed(gates.a.release, undefined);
      const resultA = yield* Fiber.join(copyA);
      expect(resultA.rejected).toEqual([rejection(1)]);
      expect(resultA.hints).toEqual([]);
      expect(resultA.lastMutationIds[clientId]).toBe(1);

      // Neither copy's effects are visible, and the id is bumped once.
      expect(yield* backend.getRows(context, rows, ["x", "counter"])).toEqual([]);
      expect(yield* backend.lastMutationIds(context)).toEqual({ [clientId]: 1 });
    })
  );

  it.effect("a replay reports a committed rejection until the client's next push passes it", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make(outcomeHandlers(yield* makeGates));

      yield* backend.applyMutations(context, [rejectedMutation(1)]);

      // A retry after a lost response is a replay: no effects, and the same outcome.
      const replay = yield* backend.applyMutations(context, [rejectedMutation(1)]);
      expect(replay.rejected).toEqual([rejection(1)]);
      expect(replay.hints).toEqual([]);

      // The client's next push starts at 2, so it has already seen the outcome of 1. The
      // rejection is forgotten then, which bounds what a backend keeps (see Backend.ts).
      yield* backend.applyMutations(context, [mutation(2, "test/set", { id: "y", n: 2 })]);
      const late = yield* backend.applyMutations(context, [rejectedMutation(1)]);
      expect(late.rejected).toBeUndefined();
      expect(late.lastMutationIds[clientId]).toBe(2);
    })
  );
});

/**
 * A push gate: the test sees when the backend has answered a push, and decides
 * when that response reaches the client (#355).
 */
interface PushGate {
  readonly returned: Deferred.Deferred<void>;
  readonly deliver: Deferred.Deferred<void>;
}

const pushGate = Effect.gen(function* () {
  return {
    returned: yield* Deferred.make<void>(),
    deliver: yield* Deferred.make<void>(),
  } satisfies PushGate;
});

/** Wraps the in-memory transport so the test chooses the order responses reach the client. */
const racingTransport = (
  inner: ClientTransport,
  pushes: Ref.Ref<number>,
  gates: ReadonlyArray<PushGate>
): ClientTransport => ({
  ...inner,
  push: (request) =>
    Effect.gen(function* () {
      const gate = gates[(yield* Ref.updateAndGet(pushes, (n) => n + 1)) - 1]!;
      const response = yield* inner.push(request);
      yield* Deferred.succeed(gate.returned, undefined);
      yield* Deferred.await(gate.deliver);
      return response;
    }),
});

const raceContext: SyncContext = { clientGroupId: "group-a" };

const raceMutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/race", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { readonly id: string }).id, args),
  },
]);

/**
 * `todo/race`: the first copy to reach the backend parks, then applies once the
 * second copy has committed. The second copy is rejected at once.
 */
const raceHandlers = (
  copies: Ref.Ref<number>,
  parked: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
): Record<string, MemoryBackend.BackendHandler> => ({
  "todo/race": (args, writer) =>
    Effect.gen(function* () {
      const copy = yield* Ref.updateAndGet(copies, (n) => n + 1);
      if (copy > 1) return yield* new MutationRejected({ reason: "forbidden" });
      yield* Deferred.succeed(parked.entered, undefined);
      yield* Deferred.await(parked.release);
      yield* writer.put("todos", (args as { readonly id: string }).id, args);
    }),
});

const serverFor = (backend: Backend) =>
  Effect.gen(function* () {
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

/** The client's mutation state for one id, read as a snapshot. */
const stateOf = (engine: ClientEngineModule.ClientEngine, mutationId: number) =>
  Stream.runHead(engine.mutationStates).pipe(
    Effect.map((head) =>
      Option.isSome(head) ? Option.getOrUndefined(HashMap.get(head.value, mutationId)) : undefined
    )
  );

/**
 * Subscribes to the engine's events now, before the mutation under test, and
 * returns `read`: every event emitted before its call, once it has returned.
 *
 * `Stream.toPull` subscribes on its first pull, so a reader forked here
 * subscribes only when it first runs, and events emitted before that are lost.
 * The set-up therefore pulls until the reader has seen one of the `PullCompleted`
 * events those pulls emit, which proves the subscription is live. `read` pulls
 * once more and waits for the reader to reach that event, so it never misses one
 * and needs no wall-clock wait.
 */
const openEngineEvents = (engine: ClientEngineModule.ClientEngine) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(engine.engineEvents);
    const seen = yield* Ref.make<ReadonlyArray<ClientEngineModule.EngineEvent>>([]);
    const pullsSeen = Ref.get(seen).pipe(
      Effect.map((events) => events.filter((event) => event._tag === "PullCompleted").length)
    );
    yield* Effect.forkScoped(
      Effect.forever(
        pull.pipe(Effect.flatMap((chunk) => Ref.update(seen, (prior) => [...prior, ...chunk])))
      )
    );
    while ((yield* pullsSeen) === 0) {
      yield* engine.pull;
      yield* Effect.yieldNow;
    }
    return {
      read: Effect.gen(function* () {
        const before = yield* pullsSeen;
        yield* engine.pull;
        while ((yield* pullsSeen) === before) yield* Effect.yieldNow;
        return yield* Ref.get(seen);
      }),
    };
  });

/** The mutation-lifecycle event tags emitted for one mutation id, in order. */
const mutationTagsOf = (
  events: ReadonlyArray<ClientEngineModule.EngineEvent>,
  mutationId: number
) =>
  events.flatMap((event) =>
    "mutationId" in event && event.mutationId === mutationId ? [event._tag] : []
  );

/**
 * One mutation, two copies racing at the backend (#355). The first copy parks
 * and applies only after the second, which is rejected and commits first. The
 * client receives the two responses in the given order; either way it must
 * settle the mutation as the server committed it, and emit that outcome once
 * (#364): both responses report the rejection, but the second repeats it.
 */
const runRace = (order: "rejected-first" | "losing-first") =>
  Effect.gen(function* () {
    const copies = yield* Ref.make(0);
    const parked = {
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    const backend = yield* MemoryBackend.make(raceHandlers(copies, parked));
    const handler = yield* serverFor(backend);
    const store = yield* ClientStoreModule.makeMemory;
    const pushes = yield* Ref.make(0);
    const gates = [yield* pushGate, yield* pushGate] as const;
    const transport = yield* makeInMemory(handler, "group-a");
    const engine = yield* ClientEngineModule.make({
      clientId: "client-a",
      clientGroupId: "group-a",
      mutators: raceMutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, racingTransport(transport, pushes, gates))
    );
    yield* engine.subscribe(Subset.make({ collection: "todos" }));
    const events = yield* openEngineEvents(engine);

    const handle = yield* engine.mutateWithAck("todo/race", {
      id: "x",
      title: "doomed",
      done: false,
    });
    // Copy A reaches the backend first and parks inside its handler.
    const pushA = yield* Effect.forkChild(engine.push);
    yield* Deferred.await(parked.entered);
    // Copy B is a second push of the same entry. It is rejected and commits first.
    const pushB = yield* Effect.forkChild(engine.push);
    yield* Deferred.await(gates[1].returned);
    // A resumes and loses. Its response is ready but has not reached the client.
    yield* Deferred.succeed(parked.release, undefined);
    yield* Deferred.await(gates[0].returned);

    const pushFibers = [pushA, pushB] as const;
    for (const index of order === "rejected-first" ? [1, 0] : [0, 1]) {
      yield* Deferred.succeed(gates[index].deliver, undefined);
      yield* Fiber.join(pushFibers[index]!);
    }

    // The client settles as the server committed: rejected, with no effects shown.
    expect(yield* handle.acknowledged).toEqual({ _tag: "rejected", reason: "forbidden" });
    expect(yield* stateOf(engine, 1)).toMatchObject({ phase: "rejected", reason: "forbidden" });
    expect(yield* store.pendingMutations).toEqual([]);
    expect(yield* engine.query(Subset.make({ collection: "todos" }))).toEqual([]);

    // The server agrees: no effects, and the id is bumped.
    expect(yield* backend.getRows(raceContext, "todos", ["x"])).toEqual([]);
    expect(yield* backend.lastMutationIds(raceContext)).toEqual({ "client-a": 1 });

    // A pull changes nothing the client shows.
    yield* engine.pull;
    expect(yield* engine.query(Subset.make({ collection: "todos" }))).toEqual([]);

    // Both responses reported the rejection, but the outcome is emitted once.
    expect(mutationTagsOf(yield* events.read, 1)).toEqual([
      "MutationJournaled",
      "MutationRejected",
    ]);
  });

/**
 * Adds one more rejected entry to the response of the push numbered `pushNumber`
 * (1-based): a report the client has already seen contradicted, or repeated.
 */
const withLateRejection = (
  inner: ClientTransport,
  pushNumber: number,
  report: { readonly clientId: string; readonly mutationId: number; readonly reason: string }
): Effect.Effect<ClientTransport> =>
  Effect.gen(function* () {
    const pushes = yield* Ref.make(0);
    return {
      ...inner,
      push: (request) =>
        Effect.gen(function* () {
          const response = yield* inner.push(request);
          const sent = yield* Ref.updateAndGet(pushes, (n) => n + 1);
          return sent === pushNumber
            ? { ...response, rejected: [...(response.rejected ?? []), report] }
            : response;
        }),
    };
  });

const setMutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as { readonly id: string }).id, args),
  },
]);

describe("ClientEngine outcome of a race between a rejected and an applied copy (#355)", () => {
  it.effect("the rejected copy's response arrives first", () => runRace("rejected-first"));

  it.effect("the losing copy's response arrives first", () => runRace("losing-first"));
});

describe("ClientEngine settled outcomes are not re-settled (#364)", () => {
  it.effect("a rejection reported after the entry was acknowledged is ignored", () =>
    Effect.gen(function* () {
      const backend = yield* MemoryBackend.make({
        "todo/set": (args, writer) =>
          writer.put("todos", (args as { readonly id: string }).id, args),
      });
      const handler = yield* serverFor(backend);
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-a");
      // The second push's response reports mutation 1 rejected, though the client already has it applied.
      const contradicting = yield* withLateRejection(transport, 2, {
        clientId: "client-a",
        mutationId: 1,
        reason: "forbidden",
      });
      const engine = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators: setMutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, contradicting)
      );
      yield* engine.subscribe(Subset.make({ collection: "todos" }));
      const events = yield* openEngineEvents(engine);

      const first = yield* engine.mutateWithAck("todo/set", { id: "x", title: "a", done: false });
      yield* engine.push;
      expect(yield* first.acknowledged).toEqual({ _tag: "applied" });

      yield* engine.mutate("todo/set", { id: "y", title: "b", done: false });
      yield* engine.push;

      // The applied outcome stands: no phase change, no event, and the second entry settles normally.
      expect(yield* stateOf(engine, 1)).toMatchObject({ phase: "acknowledged" });
      expect((yield* stateOf(engine, 1))?.reason).toBeUndefined();
      expect(yield* stateOf(engine, 2)).toMatchObject({ phase: "acknowledged" });
      expect(yield* store.pendingMutations).toEqual([]);

      yield* engine.pull;
      expect(mutationTagsOf(yield* events.read, 1)).toEqual([
        "MutationJournaled",
        "MutationAcknowledged",
      ]);
      expect(yield* backend.lastMutationIds(raceContext)).toEqual({ "client-a": 2 });
    })
  );
});
