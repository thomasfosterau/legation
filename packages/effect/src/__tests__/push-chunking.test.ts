/**
 * A push that carries more than the pull-ahead threshold goes in chunks of that size, with a pull
 * between them, so an oversized journal never takes the acknowledged tail past the bound (#429).
 * The log of requests and pulls shows the chunk boundaries, the tail each request found, and the
 * order the server sees the mutations in.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Logger, Ref, Schedule, Schema } from "effect";
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

      // The push returns without failing: the pull's failure is surfaced as a pull, and the push stops.
      expect(Exit.isSuccess(yield* Effect.exit(engine.push))).toBe(true);
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
      // would start (#337); pulls are refused until it has failed, so the tail stays at 5. The second push
      // then has 4 entries of room, not a whole chunk of 5 (#429).
      const server = yield* serverOver(yield* MemoryBackend.make(backendHandlers));
      const store = yield* ClientStoreModule.makeMemory;
      const inner = yield* makeInMemory(server, "group-a");
      const pullsRefused = yield* Ref.make(true);
      const refusedPulls: ClientTransport = {
        ...inner,
        pull: (request) =>
          Ref.get(pullsRefused).pipe(
            Effect.flatMap((refused) =>
              refused
                ? Effect.fail(
                    new VersionNotSupportedError({ message: "pulls refused by the test" })
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
      // Let the pull ahead that the push started fail under the refusal, then accept pulls again.
      for (let i = 0; i < 3; i++) yield* Effect.yieldNow;
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
});
