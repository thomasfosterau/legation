/**
 * A push that carries more than the pull-ahead threshold goes in chunks of that size, with a pull
 * between them, so an oversized journal never takes the acknowledged tail past the bound (#429).
 * The log of requests and pulls shows the chunk boundaries, the tail each request found, and the
 * order the server sees the mutations in.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientStoreModule from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import { TransportError, VersionNotSupportedError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory } from "../Transport.js";

// The ids from `from` to `to`, comma-separated, as a log line shows them.
const range = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join(",");

// A non-idempotent counter: a double application shows as an extra count.
const counterWrite = <E>(
  writer: {
    readonly get: (collection: string, id: string) => Effect.Effect<unknown, E>;
    readonly put: (collection: string, id: string, value: unknown) => Effect.Effect<void, E>;
  },
  id: string
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const current = (yield* writer.get("counters", id)) as { readonly n: number } | undefined;
    yield* writer.put("counters", id, { id, n: (current?.n ?? 0) + 1 });
  });

const counterMutators = Mutator.registry([
  {
    mutator: Mutator.make("counter/inc", Schema.Unknown),
    local: (args, writer) => counterWrite(writer, (args as { readonly id: string }).id),
  },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "counter/inc": (args, writer) => counterWrite(writer, (args as { readonly id: string }).id),
};

const authPolicy = Authorization.policy({ counters: Authorization.allowAll });
const countersSubset = Subset.make({ collection: "counters" });

// With a bound of 8 the threshold is 4; with 16 it is 8. The cases below avoid a push that ends on a
// full chunk: that would start a pull ahead (#337), which is asynchronous and would show in the log.
const SMALL_LIMIT = 8;

const serverOver = (backend: Backend) =>
  Effect.gen(function* () {
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(Authorization.AuthPolicy, authPolicy),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
  });

// A transport whose pulls are refused while `refusing` is set: a version rejection, which the engine does
// not retry. Pushes are not affected.
const refusingPulls = (inner: ClientTransport, refusing: Ref.Ref<boolean>): ClientTransport => ({
  ...inner,
  pull: (request) =>
    Ref.get(refusing).pipe(
      Effect.flatMap((on) =>
        on
          ? Effect.fail(new VersionNotSupportedError({ message: "pulls refused by the test" }))
          : inner.pull(request)
      )
    ),
});

// Logs each push request, with the mutation ids it carries and the tail the request found, and each
// pull, in the order they happen.
const logged = (
  inner: ClientTransport,
  store: ClientStore,
  log: Array<string>
): ClientTransport => ({
  ...inner,
  push: (request) =>
    Effect.gen(function* () {
      const tail = (yield* store.unpulled.pipe(Effect.orDie)).length;
      const ids = request.mutations.map((m) => m.mutationId).join(",");
      log.push(`push ${ids} tail=${tail}`);
      return yield* inner.push(request);
    }),
  pull: (request) =>
    Effect.gen(function* () {
      log.push("pull");
      return yield* inner.pull(request);
    }),
});

// The push requests in `log`, as their ids alone.
const pushIds = (log: ReadonlyArray<string>): ReadonlyArray<string> =>
  log.filter((line) => line.startsWith("push ")).map((line) => line.replace(/ tail=\d+$/, ""));

const engineOver = (
  transport: ClientTransport,
  store: ClientStore,
  options: {
    readonly unpulledLimit?: number | undefined;
    readonly retry?: ClientEngineModule.RetryOptions | undefined;
  } = {}
) =>
  ClientEngineModule.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators: counterMutators,
    ...(options.unpulledLimit === undefined ? {} : { unpulledLimit: options.unpulledLimit }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );

const counterValue = (engine: ClientEngineModule.ClientEngine) =>
  engine
    .query(countersSubset)
    .pipe(
      Effect.map(
        (rows) => (rows.find((row) => row.id === "c")?.value as { n: number } | undefined)?.n
      )
    );

const journalIds = (store: ClientStore) =>
  store.pendingMutations.pipe(Effect.map((ms) => ms.map((m) => m.mutationId)));

const tailIds = (store: ClientStore) =>
  store.unpulled.pipe(Effect.map((ms) => ms.map((m) => m.mutationId)));

// The engine over a fresh in-memory server, with `count` increments journaled and nothing pushed.
const journaled = (count: number, unpulledLimit?: number) =>
  Effect.gen(function* () {
    const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
    const store = yield* ClientStoreModule.makeMemory;
    const log: Array<string> = [];
    const inner = yield* makeInMemory(server, "group-a");
    const engine = yield* engineOver(logged(inner, store, log), store, { unpulledLimit });
    yield* engine.subscribe(countersSubset);
    for (let i = 0; i < count; i++) yield* engine.mutate("counter/inc", { id: "c" });
    return { engine, store, log };
  });

describe("a push larger than the pull-ahead threshold (#429)", () => {
  it.effect(
    "with pokes off and no pullInterval, a push past the bound releases nothing early",
    () =>
      Effect.gen(function* () {
        // Default bound (1024): 1100 mutations go as 512, 512 and 76, with a pull after each of the first
        // two. Nothing overflows, so no warning is logged.
        const warnings: Array<string> = [];
        const logger = Logger.make((options) => {
          if (options.logLevel === "Warn") warnings.push(String(options.message));
        });
        const { engine, store, log } = yield* journaled(1100);
        yield* engine.push.pipe(Effect.provide(Logger.layer([logger])));
        expect(log).toEqual([
          `push ${range(1, 512)} tail=0`,
          "pull",
          `push ${range(513, 1024)} tail=0`,
          "pull",
          `push ${range(1025, 1100)} tail=0`,
        ]);
        // The last chunk is the only tail left, and the view shows every increment.
        expect(yield* tailIds(store)).toHaveLength(76);
        expect(yield* counterValue(engine)).toBe(1100);
        expect(warnings).toEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect("the chunk boundaries and request count follow ceil(N / threshold)", () =>
    Effect.gen(function* () {
      // Bound 16, threshold 8. Each row: the mutations journaled, and the requests the push sends.
      const cases: ReadonlyArray<readonly [number, ReadonlyArray<string>]> = [
        [7, [`push ${range(1, 7)} tail=0`]],
        [9, [`push ${range(1, 8)} tail=0`, "pull", "push 9 tail=0"]],
        [
          17,
          [
            `push ${range(1, 8)} tail=0`,
            "pull",
            `push ${range(9, 16)} tail=0`,
            "pull",
            "push 17 tail=0",
          ],
        ],
        [
          20,
          [
            `push ${range(1, 8)} tail=0`,
            "pull",
            `push ${range(9, 16)} tail=0`,
            "pull",
            `push ${range(17, 20)} tail=0`,
          ],
        ],
      ];
      for (const [count, expected] of cases) {
        const { engine, log } = yield* journaled(count, 16);
        yield* engine.push;
        expect(log).toEqual(expected);
        expect(yield* counterValue(engine)).toBe(count);
      }
    }).pipe(Effect.scoped)
  );

  it.effect("a failing chunk ends the push, and the unsent mutations stay journaled", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const inner = yield* makeInMemory(server, "group-a");
      const pushes = yield* Ref.make(0);
      const failSecond: ClientTransport = {
        ...inner,
        push: (request) =>
          Ref.updateAndGet(pushes, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n === 2
                ? Effect.fail(new TransportError({ message: "second chunk lost" }))
                : inner.push(request)
            )
          ),
      };
      // No retry, so the failed chunk ends the push at once.
      const engine = yield* engineOver(failSecond, store, {
        unpulledLimit: SMALL_LIMIT,
        retry: { push: Schedule.recurs(0) },
      });
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 9; i++) yield* engine.mutate("counter/inc", { id: "c" });

      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      // Chunk one is acknowledged, and the pull before chunk two released its tail. Chunk two failed, so
      // it and the one after it are still journaled, in order.
      expect(yield* tailIds(store)).toEqual([]);
      expect(yield* journalIds(store)).toEqual([5, 6, 7, 8, 9]);
      expect(yield* counterValue(engine)).toBe(9);

      // The next push sends them.
      yield* engine.push;
      expect(yield* journalIds(store)).toEqual([]);
      expect(yield* counterValue(engine)).toBe(9);
    })
  );

  it.effect("a failing pull between chunks stops the push, and the rest stays journaled", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const log: Array<string> = [];
      const inner = yield* makeInMemory(server, "group-a");
      const pullsDown = yield* Ref.make(true);
      const flakyPulls: ClientTransport = {
        ...inner,
        pull: (request) =>
          Ref.get(pullsDown).pipe(
            Effect.flatMap((down) =>
              down ? Effect.fail(new TransportError({ message: "pull down" })) : inner.pull(request)
            )
          ),
      };
      // No retry, so the failed pull between the chunks is final.
      const engine = yield* engineOver(logged(flakyPulls, store, log), store, {
        unpulledLimit: SMALL_LIMIT,
        retry: { pull: Schedule.recurs(0) },
      });
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 9; i++) yield* engine.mutate("counter/inc", { id: "c" });

      // The failed pull between the chunks fails the push with a transport error, and the push stops: the
      // unsent mutations stay journaled.
      const failure = yield* Effect.flip(engine.push);
      expect(failure._tag).toBe("TransportError");
      expect(pushIds(log)).toEqual([`push ${range(1, 4)}`]);
      expect(yield* tailIds(store)).toEqual([1, 2, 3, 4]);
      expect(yield* journalIds(store)).toEqual([5, 6, 7, 8, 9]);

      // Once pulls work, the next push sends the rest, and its pull releases the tail.
      yield* Ref.set(pullsDown, false);
      yield* engine.push;
      expect(pushIds(log)).toEqual([`push ${range(1, 4)}`, `push ${range(5, 8)}`, "push 9"]);
      expect(yield* journalIds(store)).toEqual([]);
      expect(yield* counterValue(engine)).toBe(9);
    }).pipe(Effect.scoped)
  );

  it.effect("an odd bound: a push into a tail at the threshold never takes it past the bound", () =>
    Effect.gen(function* () {
      // Bound 9, threshold 5. The first push's acknowledged tail reaches the threshold, where a pull ahead
      // would start (#337); pulls are refused until that pull has reached the refusal, so the tail stays at
      // 5. The second push then has 4 entries of room, not a whole chunk of 5 (#429).
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const inner = yield* makeInMemory(server, "group-a");
      const pullsRefused = yield* Ref.make(true);
      const refusedCalled = yield* Deferred.make<void>();
      const refusedPulls: ClientTransport = {
        ...inner,
        pull: (request) =>
          Ref.get(pullsRefused).pipe(
            Effect.flatMap((refused) =>
              refused
                ? Deferred.succeed(refusedCalled, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new VersionNotSupportedError({ message: "pulls refused by the test" })
                      )
                    )
                  )
                : inner.pull(request)
            )
          ),
      };
      const log: Array<string> = [];
      const warnings: Array<string> = [];
      const logger = Logger.make((options) => {
        if (options.logLevel === "Warn") warnings.push(String(options.message));
      });
      const engine = yield* engineOver(logged(refusedPulls, store, log), store, {
        unpulledLimit: 9,
      });
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 5; i++) yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push;
      // The pull ahead the push started (#337) has reached the refusal, so it has failed; accept pulls again.
      yield* Deferred.await(refusedCalled);
      yield* Ref.set(pullsRefused, false);
      expect(yield* tailIds(store)).toEqual([1, 2, 3, 4, 5]);

      for (let i = 0; i < 9; i++) yield* engine.mutate("counter/inc", { id: "c" });
      yield* engine.push.pipe(Effect.provide(Logger.layer([logger])));
      // The second push sends 4 (filling the tail to the bound), pulls, then sends the last 5.
      expect(pushIds(log)).toEqual([
        `push ${range(1, 5)}`,
        `push ${range(6, 9)}`,
        `push ${range(10, 14)}`,
      ]);
      expect(warnings).toEqual([]);
      expect(yield* counterValue(engine)).toBe(14);
      expect(yield* journalIds(store)).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("a full tail waits for a pull, and a failed pull sends nothing over the bound", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const inner = yield* makeInMemory(server, "group-a");
      const pullsDown = yield* Ref.make(true);
      const downPulls: ClientTransport = {
        ...inner,
        pull: (request) =>
          Ref.get(pullsDown).pipe(
            Effect.flatMap((down) =>
              down ? Effect.fail(new TransportError({ message: "pull down" })) : inner.pull(request)
            )
          ),
      };
      const log: Array<string> = [];
      const engine = yield* engineOver(logged(downPulls, store, log), store, {
        unpulledLimit: SMALL_LIMIT,
        retry: { pull: Schedule.recurs(0), push: Schedule.recurs(0) },
      });
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 8; i++) yield* engine.mutate("counter/inc", { id: "c" });

      // The first chunk (four) is acknowledged; the pull before the second fails, so the push fails.
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      // The next push's first chunk fills the tail to the bound, and no pull is needed for that.
      yield* engine.push;
      expect(yield* tailIds(store)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(yield* journalIds(store)).toEqual([]);

      for (let i = 9; i <= 12; i++) yield* engine.mutate("counter/inc", { id: "c" });
      // The tail has no room and the pull fails: the push stops before it sends anything, and the
      // one-entry fallback that a full tail used to take is gone (#429).
      expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
      expect(pushIds(log)).toEqual([`push ${range(1, 4)}`, `push ${range(5, 8)}`]);
      expect(yield* tailIds(store)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(yield* journalIds(store)).toEqual([9, 10, 11, 12]);

      // Once pulls work, the pull releases the tail, and the rest goes out.
      yield* Ref.set(pullsDown, false);
      yield* engine.push;
      expect(pushIds(log)).toEqual([
        `push ${range(1, 4)}`,
        `push ${range(5, 8)}`,
        `push ${range(9, 12)}`,
      ]);
      expect(yield* journalIds(store)).toEqual([]);
      expect(yield* counterValue(engine)).toBe(12);
    }).pipe(Effect.scoped)
  );

  it.effect("a pull between chunks that releases nothing fails the push, and the bound holds", () =>
    Effect.gen(function* () {
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const inner = yield* makeInMemory(server, "group-a");
      // While `silent`, pulls succeed but acknowledge nothing, so no pull releases the tail.
      const silent = yield* Ref.make(false);
      const releasesNothing: ClientTransport = {
        ...inner,
        pull: (request) =>
          Ref.get(silent).pipe(
            Effect.flatMap((on) =>
              inner
                .pull(request)
                .pipe(
                  Effect.map((response) => (on ? { ...response, lastMutationIds: {} } : response))
                )
            )
          ),
      };
      const log: Array<string> = [];
      const engine = yield* engineOver(logged(releasesNothing, store, log), store, {
        unpulledLimit: SMALL_LIMIT,
      });
      yield* engine.subscribe(countersSubset);
      for (let i = 0; i < 9; i++) yield* engine.mutate("counter/inc", { id: "c" });

      yield* Ref.set(silent, true);
      const failure = yield* Effect.flip(engine.push);
      expect(failure._tag).toBe("TransportError");
      // The tail filled to the bound and stopped there: the ninth mutation was never sent over it.
      expect(pushIds(log)).toEqual([`push ${range(1, 4)}`, `push ${range(5, 8)}`]);
      expect(yield* tailIds(store)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(yield* journalIds(store)).toEqual([9]);

      // The view is not checked here: a pull that reports effects it does not cover is the double application
      // ADR-0008 describes, so only the tail and the journal are. Once a pull releases the tail, the ninth goes out.
      yield* Ref.set(silent, false);
      yield* engine.push;
      expect(yield* journalIds(store)).toEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "an interrupt between chunks leaves the acknowledged chunk and the journal consistent",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(server, "group-a");
        const reached = yield* Deferred.make<void>();
        const parkNextPull = yield* Ref.make(true);
        // The first pull, the one between the two chunks, never returns.
        const parkedPulls: ClientTransport = {
          ...inner,
          pull: (request) =>
            Ref.getAndSet(parkNextPull, false).pipe(
              Effect.flatMap((park) =>
                park
                  ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
                  : inner.pull(request)
              )
            ),
        };
        const engine = yield* engineOver(parkedPulls, store, { unpulledLimit: SMALL_LIMIT });
        yield* engine.subscribe(countersSubset);
        for (let i = 0; i < 9; i++) yield* engine.mutate("counter/inc", { id: "c" });

        const fiber = yield* Effect.forkScoped(engine.push);
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(fiber);

        // The first chunk is acknowledged and its tail is held; the rest is journaled, nothing is lost.
        expect(yield* tailIds(store)).toEqual([1, 2, 3, 4]);
        expect(yield* journalIds(store)).toEqual([5, 6, 7, 8, 9]);
        expect(yield* counterValue(engine)).toBe(9);

        // A later push completes the journal, and the pull that follows releases the tail.
        yield* engine.push;
        expect(yield* journalIds(store)).toEqual([]);
        yield* engine.pull;
        expect(yield* tailIds(store)).toEqual([]);
        expect(yield* counterValue(engine)).toBe(9);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "two pushes that fail their first chunk give the room back, and a healthy push still gets the whole bound",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(server, "group-a");
        // The first two requests are each a push's first chunk, and both are lost.
        const requests = yield* Ref.make(0);
        const lostFirstTwo: ClientTransport = {
          ...inner,
          push: (request) =>
            Ref.updateAndGet(requests, (n) => n + 1).pipe(
              Effect.flatMap((n) =>
                n <= 2
                  ? Effect.fail(new TransportError({ message: "chunk lost" }))
                  : inner.push(request)
              )
            ),
        };
        const log: Array<string> = [];
        // No retry, so each failed chunk ends its push at once.
        const engine = yield* engineOver(logged(lostFirstTwo, store, log), store, {
          unpulledLimit: SMALL_LIMIT,
          retry: { push: Schedule.recurs(0) },
        });
        yield* engine.subscribe(countersSubset);
        for (let i = 0; i < SMALL_LIMIT; i++) yield* engine.mutate("counter/inc", { id: "c" });

        expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(engine.push))).toBe(true);
        expect(yield* journalIds(store)).toEqual(range(1, SMALL_LIMIT).split(",").map(Number));

        // The tail is empty and the room of both failed chunks is back: the healthy push sends the
        // whole journal, four at a time, with the tail at four when the second chunk goes.
        yield* engine.push;
        expect(pushIds(log)).toEqual([
          `push ${range(1, 4)}`,
          `push ${range(1, 4)}`,
          `push ${range(1, 4)}`,
          `push ${range(5, 8)}`,
        ]);
        expect(yield* journalIds(store)).toEqual([]);
        expect(yield* counterValue(engine)).toBe(SMALL_LIMIT);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "interrupted pushes give the room back: after two are cut off mid-chunk, a healthy push gets the whole bound",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(server, "group-a");
        // Until `healthy` is set, a push's round trip never returns. The second one to park signals.
        const healthy = yield* Ref.make(false);
        const parked = yield* Ref.make(0);
        const twoParked = yield* Deferred.make<void>();
        const parkingPushes: ClientTransport = {
          ...inner,
          push: (request) =>
            Ref.get(healthy).pipe(
              Effect.flatMap((on) =>
                on
                  ? inner.push(request)
                  : Ref.updateAndGet(parked, (n) => n + 1).pipe(
                      Effect.flatMap((n) =>
                        (n === 2 ? Deferred.succeed(twoParked, undefined) : Effect.void).pipe(
                          Effect.andThen(Effect.never)
                        )
                      )
                    )
              )
            ),
        };
        const log: Array<string> = [];
        const engine = yield* engineOver(logged(parkingPushes, store, log), store, {
          unpulledLimit: SMALL_LIMIT,
        });
        yield* engine.subscribe(countersSubset);
        for (let i = 0; i < SMALL_LIMIT; i++) yield* engine.mutate("counter/inc", { id: "c" });

        // Both pushes reserve a chunk of four, which fills the bound while they are in flight.
        const first = yield* Effect.forkScoped(engine.push);
        const second = yield* Effect.forkScoped(engine.push);
        yield* Deferred.await(twoParked);
        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);

        // Nothing was acknowledged, so the journal is intact. The interrupted chunks gave their room back.
        expect(yield* tailIds(store)).toEqual([]);
        expect(yield* journalIds(store)).toEqual(range(1, SMALL_LIMIT).split(",").map(Number));

        yield* Ref.set(healthy, true);
        yield* engine.push;
        expect(pushIds(log).slice(-2)).toEqual([`push ${range(1, 4)}`, `push ${range(5, 8)}`]);
        expect(yield* journalIds(store)).toEqual([]);
        expect(yield* counterValue(engine)).toBe(SMALL_LIMIT);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "overlapping pushes share the bound: the tail and the chunks in flight never pass it",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(server, "group-a");
        // Pulls are refused, so nothing releases the tail: the bound is only what the pushes leave.
        const refusing = yield* Ref.make(true);
        // Mutations in requests that have not returned yet, and the widest the tail could grow to: the tail
        // as a request finds it, plus everything in flight, since each of those may be acknowledged.
        const inFlight = yield* Ref.make(0);
        const widest = yield* Ref.make(0);
        // Each request waits at the gate, so a push that is not held back would send alongside the others.
        const gate = yield* Deferred.make<void>();
        const gated: ClientTransport = {
          ...refusingPulls(inner, refusing),
          push: (request) =>
            Effect.gen(function* () {
              const size = request.mutations.length;
              const tail = (yield* store.unpulled.pipe(Effect.orDie)).length;
              const now = yield* Ref.updateAndGet(inFlight, (n) => n + size);
              yield* Ref.update(widest, (w) => Math.max(w, tail + now));
              yield* Deferred.await(gate);
              const response = yield* inner.push(request);
              yield* Ref.update(inFlight, (n) => n - size);
              return response;
            }),
        };
        const engine = yield* engineOver(gated, store, { unpulledLimit: SMALL_LIMIT });
        yield* engine.subscribe(countersSubset);
        for (let i = 0; i < 4 * SMALL_LIMIT; i++) yield* engine.mutate("counter/inc", { id: "c" });

        const pushes = yield* Effect.forEach([1, 2, 3], () =>
          Effect.forkScoped(Effect.exit(engine.push))
        );
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        const exits = yield* Effect.forEach(pushes, Fiber.join);

        // Every push stops at the pull between its chunks, as nothing is released.
        expect(exits.every(Exit.isFailure)).toBe(true);
        expect(yield* Ref.get(widest), "the tail plus the chunks in flight").toBeLessThanOrEqual(
          SMALL_LIMIT
        );
        expect(yield* tailIds(store)).toEqual(
          Array.from({ length: SMALL_LIMIT / 2 }, (_, i) => i + 1)
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a tail persisted above a lowered bound: a push pulls first, and fails if the pull fails",
    () =>
      Effect.gen(function* () {
        const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
        const store = yield* ClientStoreModule.makeMemory;
        const inner = yield* makeInMemory(server, "group-a");
        const refusing = yield* Ref.make(true);
        // Written under a bound of 16: eight pushed and acknowledged, then four more, the tail at 12.
        const wide = yield* engineOver(refusingPulls(inner, refusing), store, {
          unpulledLimit: 16,
        });
        yield* wide.subscribe(countersSubset);
        for (let i = 0; i < 8; i++) yield* wide.mutate("counter/inc", { id: "c" });
        yield* wide.push;
        for (let i = 0; i < 4; i++) yield* wide.mutate("counter/inc", { id: "c" });
        yield* wide.push;
        expect(yield* tailIds(store)).toHaveLength(12);

        // A lower bound, opened over the same store: the tail is already above it.
        const narrow = yield* engineOver(refusingPulls(inner, refusing), store, {
          unpulledLimit: SMALL_LIMIT,
        });
        yield* narrow.subscribe(countersSubset);
        yield* narrow.mutate("counter/inc", { id: "c" });
        const failed = yield* Effect.exit(narrow.push);
        expect(Exit.isFailure(failed)).toBe(true);
        // The push waited for a pull that was refused: nothing was sent, released or overflowed.
        expect(yield* tailIds(store)).toHaveLength(12);
        expect(yield* journalIds(store)).toEqual([13]);

        // Pulls accepted again: the pull drains the tail, and the push sends the journaled mutation.
        yield* Ref.set(refusing, false);
        yield* narrow.push;
        expect(yield* journalIds(store)).toEqual([]);
        expect(yield* counterValue(narrow)).toBe(13);
        expect(yield* tailIds(store).pipe(Effect.map((ids) => ids.length <= SMALL_LIMIT))).toBe(
          true
        );
      }).pipe(Effect.scoped)
  );
});
