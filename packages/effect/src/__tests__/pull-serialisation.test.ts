/**
 * Pull serialisation (#412): pulls run one at a time, each in its caller's fibre, and a caller
 * waits only for a pull that starts after it asked. Two responses can then never be applied out of
 * order, so an older response cannot revert rows or the cookie, and every caller keeps its own
 * context and interruption, as on trunk.
 *
 * The fake transport holds every response until the test releases it, so each interleaving is
 * staged with Deferreds and no wall-clock time. `settle` yields a fixed number of times to let
 * runnable fibres reach a stop: under the fix a queued pull cannot reach the transport however
 * long it runs, and on trunk a second pull reaches it within a few yields.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import { TransportError } from "../Errors.js";
import * as Mutator from "../Mutator.js";
import type { Poke, PullRequest, PullResponse } from "../Protocol.js";
import * as Subset from "../Subset.js";
import { ClientTransport } from "../Transport.js";
import { defined } from "./defined.js";

/** Pulls the fake transport will serve; a test that issues more than this fails loudly. */
const PULLS = 3;

/** Pokes offered while a pull hangs in the burst test. */
const BURST = 200;

const FIXED_MILLIS = 424242;

/** A clock whose time is fixed, so a test can tell whether its context reached the transport. */
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => FIXED_MILLIS,
  currentTimeMillis: Effect.succeed(FIXED_MILLIS),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  currentTimeNanosUnsafe: () => BigInt(FIXED_MILLIS) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(FIXED_MILLIS) * 1_000_000n),
  sleep: () => Effect.void,
};

const allTodos = Subset.make({ collection: "todos" });

const settle = Effect.forEach(Array.from({ length: 300 }), () => Effect.yieldNow, {
  discard: true,
});

const todoPatch = (title: string) => [
  {
    _tag: "Put" as const,
    collection: "todos",
    id: "t1",
    version: 1,
    value: { id: "t1", title, done: false },
  },
];

const respond = (cookie: string, title: string): PullResponse => ({
  cookie,
  patch: todoPatch(title),
  lastMutationIds: {},
});

interface GatedTransport {
  readonly transport: ClientTransport;
  readonly pokes: Queue.Queue<Poke>;
  /** Resolved with the request when the n-th pull reaches the transport. */
  readonly issued: ReadonlyArray<Deferred.Deferred<PullRequest>>;
  /** Resolve or fail the n-th pull's answer to release it. */
  readonly answers: ReadonlyArray<Deferred.Deferred<PullResponse, TransportError>>;
  /** Pulls that have reached the transport so far. */
  readonly count: Effect.Effect<number>;
  /** The Clock time each pull saw when it reached the transport, in arrival order. */
  readonly clockSeen: Ref.Ref<ReadonlyArray<number>>;
  /** Pulls whose answer was still awaited when the caller interrupted them. */
  readonly cancelled: Effect.Effect<number>;
}

const makeGatedTransport: Effect.Effect<GatedTransport> = Effect.gen(function* () {
  const issued = yield* Effect.all(
    Array.from({ length: PULLS }, () => Deferred.make<PullRequest>())
  );
  const answers = yield* Effect.all(
    Array.from({ length: PULLS }, () => Deferred.make<PullResponse, TransportError>())
  );
  const pokes = yield* Queue.unbounded<Poke>();
  const calls = yield* Ref.make(0);
  const clockSeen = yield* Ref.make<ReadonlyArray<number>>([]);
  const interrupted = yield* Ref.make(0);
  const pull = (request: PullRequest) =>
    Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(calls, (n) => n + 1);
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(clockSeen, (seen) => [...seen, now]);
      const signal = issued[index];
      const answer = answers[index];
      if (signal === undefined || answer === undefined) {
        return yield* Effect.die(new Error(`unexpected pull #${index}`));
      }
      yield* Deferred.succeed(signal, request);
      return yield* Deferred.await(answer);
    }).pipe(
      // Installed before the call signals its arrival, so a caller that interrupts as soon as it
      // sees the arrival still finds the hook in place.
      Effect.onInterrupt(() => Ref.update(interrupted, (n) => n + 1))
    );
  const transport: ClientTransport = {
    push: () => Effect.die(new Error("push is not part of this test")),
    pull,
    pokes: Stream.fromQueue(pokes),
    status: Effect.succeed("disconnected"),
    statusChanges: Stream.never,
  };
  return {
    transport,
    pokes,
    issued,
    answers,
    count: Ref.get(calls),
    clockSeen,
    cancelled: Ref.get(interrupted),
  };
});

interface Client {
  readonly engine: ClientEngineModule.ClientEngine;
  readonly store: ClientStoreModule.ClientStore;
  readonly gated: GatedTransport;
}

const makeClient: Effect.Effect<Client, never, Scope.Scope> = Effect.gen(function* () {
  const gated = yield* makeGatedTransport;
  const store = yield* ClientStoreModule.makeMemory;
  const engine = yield* ClientEngineModule.make({
    clientId: "client-412",
    clientGroupId: "group-412",
    mutators: Mutator.registry([]),
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, gated.transport)
  );
  return { engine, store, gated };
});

/** The cookie the store holds and the titles the engine shows, read together. */
const snapshot = (client: Client) =>
  Effect.gen(function* () {
    const cookie = yield* client.store.getCookie;
    const rows = yield* client.engine.query(allTodos);
    return { cookie, titles: rows.map((row) => (row.value as { readonly title: string }).title) };
  });

describe("pull serialisation (#412)", () => {
  it.effect(
    "a second pull is not issued while the first is in flight, and rows and cookie never revert",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count } = client.gated;

        const first = yield* Effect.forkChild(client.engine.pull);
        yield* Deferred.await(defined(issued[0]));
        const second = yield* Effect.forkChild(client.engine.pull);
        yield* settle;
        // Both pulls would leave with the same cookie if the second one were not held back.
        expect(yield* count).toBe(1);

        yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
        yield* Fiber.join(first);
        expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["old"] });

        // The second pull starts only now, from the cookie the first one applied.
        const secondRequest = yield* Deferred.await(defined(issued[1]));
        expect(secondRequest.cookie).toBe("c1");
        yield* Deferred.succeed(defined(answers[1]), respond("c2", "new"));
        yield* Fiber.join(second);
        expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
      })
  );

  it.effect(
    "an explicit pull issued during a poke-triggered pull resolves only after a later pull is applied",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count, pokes } = client.gated;
        const explicitDone = yield* Ref.make(false);

        yield* client.engine.runSync;
        yield* Queue.offer(pokes, { reason: "test" });
        yield* Deferred.await(defined(issued[0]));

        const explicit = yield* Effect.forkChild(
          client.engine.pull.pipe(Effect.andThen(Ref.set(explicitDone, true)))
        );
        yield* settle;
        expect(yield* count).toBe(1);

        // The poke's pull lands; the explicit call still needs a pull of its own.
        yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
        yield* settle;
        expect(yield* Ref.get(explicitDone)).toBe(false);
        expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["old"] });

        const explicitRequest = yield* Deferred.await(defined(issued[1]));
        expect(explicitRequest.cookie).toBe("c1");
        yield* Deferred.succeed(defined(answers[1]), respond("c2", "new"));
        yield* Fiber.join(explicit);
        expect(yield* Ref.get(explicitDone)).toBe(true);
        expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
      })
  );

  it.effect("pokes that arrive during one pull coalesce into a single follow-up pull", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, count, pokes } = client.gated;

      yield* client.engine.runSync;
      yield* Queue.offer(pokes, { reason: "first" });
      yield* Deferred.await(defined(issued[0]));

      yield* Queue.offer(pokes, { reason: "second" });
      yield* Queue.offer(pokes, { reason: "third" });
      yield* Queue.offer(pokes, { reason: "fourth" });
      yield* settle;
      expect(yield* count).toBe(1);

      yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
      yield* Deferred.await(defined(issued[1]));
      yield* Deferred.succeed(defined(answers[1]), respond("c2", "new"));
      yield* settle;
      // The three pokes shared one follow-up; no pull was left over for them after it.
      expect(yield* count).toBe(2);
      expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
    })
  );

  it.effect("the caller's context reaches the transport call", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, clockSeen } = client.gated;

      const pulling = yield* Effect.forkChild(
        client.engine.pull.pipe(Effect.provideService(Clock.Clock, fixedClock))
      );
      yield* Deferred.await(defined(issued[0]));
      // The transport reads the clock the caller provided, not the engine's own.
      expect(yield* Ref.get(clockSeen)).toEqual([FIXED_MILLIS]);
      yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
      yield* Fiber.join(pulling);
      expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["old"] });
    })
  );

  it.effect("interrupting a caller aborts its transport call, and the next pull proceeds", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, cancelled } = client.gated;

      const abandoned = yield* Effect.forkChild(client.engine.pull);
      yield* Deferred.await(defined(issued[0]));
      yield* Fiber.interrupt(abandoned);
      // The transport call was aborted with its caller, as on trunk.
      expect(yield* cancelled).toBe(1);

      const next = yield* Effect.forkChild(client.engine.pull);
      yield* Deferred.await(defined(issued[1]));
      yield* Deferred.succeed(defined(answers[1]), respond("c1", "new"));
      yield* Fiber.join(next);
      expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["new"] });
    })
  );

  it.effect(
    "a failing pull fails its own caller, and a caller queued behind it then pulls for itself",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count } = client.gated;

        const failing = yield* Effect.forkChild(client.engine.pull);
        yield* Deferred.await(defined(issued[0]));
        const queued = yield* Effect.forkChild(client.engine.pull);
        yield* settle;
        expect(yield* count).toBe(1);

        yield* Deferred.fail(defined(answers[0]), new TransportError({ message: "offline" }));
        expect(Exit.isFailure(yield* Fiber.await(failing))).toBe(true);

        // Nothing was applied, so the queued caller's request is still unserved: it pulls now.
        yield* Deferred.await(defined(issued[1]));
        expect(yield* count).toBe(2);
        yield* Deferred.succeed(defined(answers[1]), respond("c1", "new"));
        expect(Exit.isSuccess(yield* Fiber.await(queued))).toBe(true);
        expect(yield* snapshot(client)).toEqual({ cookie: "c1", titles: ["new"] });
      })
  );

  it.effect("a poke burst during a hung pull causes exactly one follow-up pull", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, count, pokes } = client.gated;

      yield* client.engine.runSync;
      yield* Queue.offer(pokes, { reason: "first" });
      yield* Deferred.await(defined(issued[0]));

      // The burst arrives while the pull hangs. The poke stream buffers it in one slot, so the
      // burst adds no pull and no fibre per poke; the offers all complete regardless.
      for (let index = 0; index < BURST; index++) {
        yield* Queue.offer(pokes, { reason: `burst-${index}` });
      }
      yield* settle;
      expect(yield* count).toBe(1);

      yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
      yield* Deferred.await(defined(issued[1]));
      yield* Deferred.succeed(defined(answers[1]), respond("c2", "new"));
      yield* settle;
      expect(yield* count).toBe(2);
      expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
    })
  );

  it.effect("a queued caller is skipped when a pull that started after its entry is applied", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const { issued, answers, count } = client.gated;

      const first = yield* Effect.forkChild(client.engine.pull);
      yield* Deferred.await(defined(issued[0]));
      // B and C both enter while the first pull is in flight.
      const second = yield* Effect.forkChild(client.engine.pull);
      yield* settle;
      const third = yield* Effect.forkChild(client.engine.pull);
      yield* settle;
      expect(yield* count).toBe(1);

      yield* Deferred.succeed(defined(answers[0]), respond("c1", "old"));
      yield* Fiber.join(first);
      // B's pull starts after C entered, so it serves C too.
      const secondRequest = yield* Deferred.await(defined(issued[1]));
      expect(secondRequest.cookie).toBe("c1");
      yield* Deferred.succeed(defined(answers[1]), respond("c2", "new"));
      yield* Fiber.join(second);
      yield* settle;
      expect(yield* count).toBe(2);
      yield* Fiber.join(third);
      expect(yield* snapshot(client)).toEqual({ cookie: "c2", titles: ["new"] });
    })
  );

  it.effect(
    "a queued caller does not skip on a failed pull, and pulls for itself after the next one fails",
    () =>
      Effect.gen(function* () {
        const client = yield* makeClient;
        const { issued, answers, count } = client.gated;

        const first = yield* Effect.forkChild(client.engine.pull);
        yield* Deferred.await(defined(issued[0]));
        const second = yield* Effect.forkChild(client.engine.pull);
        yield* settle;
        const third = yield* Effect.forkChild(client.engine.pull);
        yield* settle;
        expect(yield* count).toBe(1);

        // The first pull fails and applies nothing, so B pulls #2 and that fails too.
        yield* Deferred.fail(defined(answers[0]), new TransportError({ message: "offline" }));
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        yield* Deferred.await(defined(issued[1]));
        yield* Deferred.fail(defined(answers[1]), new TransportError({ message: "offline" }));
        expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);

        // Neither failure applied anything, so C pulls #3 itself rather than skipping.
        yield* settle;
        expect(yield* count).toBe(3);
        yield* Deferred.await(defined(issued[2]));
        yield* Deferred.succeed(defined(answers[2]), respond("c3", "new"));
        expect(Exit.isSuccess(yield* Fiber.await(third))).toBe(true);
        expect(yield* snapshot(client)).toEqual({ cookie: "c3", titles: ["new"] });
      })
  );
});
