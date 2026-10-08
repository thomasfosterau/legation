/**
 * Bus broker tests: the WebSocket (Durable Object relay) broker and the
 * Redis Streams broker each carry a ChangeHint between two serialized buses.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  PubSub,
  Queue,
  References,
  Ref,
} from "effect";
import { Redis } from "effect/persistence";
import * as TestClock from "effect/testing/TestClock";
import type { ChangeHint } from "../Backend.js";
import * as BusBrokers from "../BusBrokers.js";
import * as InvalidationBus from "../InvalidationBus.js";

const hint: ChangeHint = { collection: "todos", ids: ["1"] };

// ─── WebSocket (Durable Object) broker ───────────────────────────────────────

/** A relay hub: every connected socket receives every sent frame (incl. sender). */
const makeHub = () => {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const connect = (): BusBrokers.WebSocketLike => ({
    send: (data) => {
      for (const listener of listeners) listener({ data });
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  });
  return { connect };
};

describe("makeWebSocketBroker (Durable Object relay pattern)", () => {
  it.effect("carries a hint from one instance's bus to another's", () =>
    Effect.gen(function* () {
      const hub = makeHub();
      const busA = InvalidationBus.makeSerialized(BusBrokers.makeWebSocketBroker(hub.connect()));
      const busB = InvalidationBus.makeSerialized(BusBrokers.makeWebSocketBroker(hub.connect()));

      const subscription = yield* busB.subscribe;
      yield* busA.publish([hint]);
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );

  it.effect("malformed frames are skipped, not delivered as hints", () =>
    Effect.gen(function* () {
      const hub = makeHub();
      const raw = hub.connect();
      const busB = InvalidationBus.makeSerialized(BusBrokers.makeWebSocketBroker(hub.connect()));
      const subscription = yield* busB.subscribe;

      raw.send("not json at all");
      raw.send(JSON.stringify({ not: "an array of hints" }));
      raw.send(JSON.stringify([hint]));
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );
});

// ─── Redis Streams broker ────────────────────────────────────────────────────

/**
 * An in-memory fake of the Redis commands the Streams broker uses. XADD
 * appends an entry; XREVRANGE returns the last entry; XREAD BLOCK resolves its
 * start ID when it is called (`$` is the stream's end at that moment, a
 * concrete ID is the entries after it) and then parks until an entry arrives
 * or the block times out. The block bound is a TestClock sleep, so it fires
 * only when a test advances virtual time.
 *
 * `events` logs the reader's steps in order, so a test can sequence against
 * them: "refused" when a command fails because `setDown(true)` is in effect,
 * "parked" once an XREAD blocks (its bound is armed), "timedOut" when a BLOCK
 * returns null, "delivered" when an XREAD returns entries. A timed-out reply is
 * held until `releaseTimeoutReply` completes, which lets a test publish after
 * the BLOCK times out, before the re-issue.
 */
// Entry IDs are `<seq>-0`, so the sequence number orders them.
const seqOf = (id: string) => Number(id.split("-")[0]);

const makeFakeRedis = Effect.gen(function* () {
  const entries = yield* Ref.make<Array<{ readonly id: string; readonly payload: string }>>([]);
  const signal = yield* PubSub.unbounded<void>();
  const events = yield* Queue.unbounded<string>();
  const readerParked = yield* Deferred.make<void>();
  const releaseTimeoutReply = yield* Deferred.make<void>();
  const refusedAt = yield* Ref.make<ReadonlyArray<number>>([]);
  let seq = 0;
  let down = false;
  let hung = false;

  // XADD <stream> * p <payload>
  const xadd = (payload: string): Effect.Effect<unknown> => {
    seq += 1;
    const id = `${seq}-0`;
    return Ref.update(entries, (es) => [...es, { id, payload }]).pipe(
      Effect.andThen(PubSub.publish(signal, undefined)),
      Effect.as(id)
    );
  };

  // XREVRANGE <stream> + - COUNT 1
  const xrevrange = (): Effect.Effect<unknown> =>
    Ref.get(entries).pipe(
      Effect.map((es) => {
        const last = es.at(-1);
        return last === undefined ? [] : [[last.id, ["p", last.payload]]];
      })
    );

  // XREAD BLOCK <ms> STREAMS <stream> <lastId>
  const xread = (stream: string, blockMs: number, lastId: string): Effect.Effect<unknown> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(signal);
        // "$" resolves at call time: only entries added after this call are read.
        const after = lastId === "$" ? seq : seqOf(lastId);
        // The bound is armed before "parked" is announced, so a test that
        // advances the clock after "parked" always fires it.
        const deadline = yield* Effect.forkScoped(Effect.sleep(Duration.millis(blockMs)), {
          startImmediately: true,
        });
        const loop = (): Effect.Effect<unknown> =>
          Effect.gen(function* () {
            const slice = (yield* Ref.get(entries)).filter((e) => seqOf(e.id) > after);
            if (slice.length > 0) {
              yield* Queue.offer(events, "delivered");
              return [[stream, slice.map((e) => [e.id, ["p", e.payload]])]];
            }
            yield* Deferred.succeed(readerParked, undefined);
            yield* Queue.offer(events, "parked");
            const woke = yield* Effect.race(
              PubSub.take(subscription).pipe(Effect.as(true)),
              Fiber.join(deadline).pipe(Effect.as(false))
            );
            if (woke) return yield* loop();
            yield* Queue.offer(events, "timedOut");
            yield* Deferred.await(releaseTimeoutReply);
            return null;
          });
        return yield* loop();
      })
    );

  // Refusal is decided inside `Effect.suspend`, so each run of a command sees the
  // current `down` state, not the state when the command was built. Each refusal
  // is also timestamped on the TestClock.
  const send = (<A>(command: string, ...args: ReadonlyArray<string>): Effect.Effect<A, Error> =>
    Effect.suspend((): Effect.Effect<unknown, Error> => {
      if (hung) return Effect.never;
      if (down) {
        return Clock.currentTimeMillis.pipe(
          Effect.tap((now) => Ref.update(refusedAt, (times) => [...times, now])),
          Effect.andThen(Queue.offer(events, "refused")),
          Effect.andThen(Effect.fail(new Error("fake Redis: connection refused")))
        );
      }
      return command === "XADD"
        ? xadd(args[3]!)
        : command === "XREVRANGE"
          ? xrevrange()
          : command === "XREAD"
            ? xread(args[3]!, Number(args[1]), args[4]!)
            : Effect.die(new Error(`fake Redis: unhandled ${command}`));
    }) as Effect.Effect<A, Error>) as Redis.Redis["Service"]["send"];

  // Makes every command fail (until `setDown(false)`), as if Redis were unreachable.
  const setDown = (value: boolean) => Effect.sync(() => void (down = value));

  // Makes every command hang (until `setHung(false)`), as if Redis never answered.
  const setHung = (value: boolean) => Effect.sync(() => void (hung = value));

  // `Redis.make` requires pub/sub too; the Streams broker only ever sends
  // commands, so a subscribe here is a test bug, not a code path.
  const subscribe = () => Effect.die(new Error("the Streams broker never subscribes"));

  return {
    redis: yield* Redis.make({ send, subscribe }),
    events,
    readerParked,
    releaseTimeoutReply,
    refusedAt,
    setDown,
    setHung,
  };
});

describe("makeRedisBroker (Redis Streams)", () => {
  it.effect("carries a hint between two buses over a shared stream", () =>
    Effect.gen(function* () {
      const { redis, readerParked } = yield* makeFakeRedis;
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, redis)
      );
      const busA = InvalidationBus.makeSerialized(yield* make);
      const busB = InvalidationBus.makeSerialized(yield* make);

      // Subscribe first ("$" = only future). Publish only once the reader has
      // resolved its start position, so the hint is past it.
      const subscription = yield* busB.subscribe;
      yield* Deferred.await(readerParked);
      yield* busA.publish([hint]);
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );

  // With Redis answering, the start position is resolved before `subscribe`
  // returns, so a publish made right after it is never missed.
  it.effect("subscribe then publish at once is delivered", () =>
    Effect.gen(function* () {
      const { redis } = yield* makeFakeRedis;
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, redis)
      );
      const busA = InvalidationBus.makeSerialized(yield* make);
      const busB = InvalidationBus.makeSerialized(yield* make);

      const subscription = yield* busB.subscribe;
      yield* busA.publish([hint]);
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );

  // The reader must resolve its start position once. Re-resolving "$" on every
  // XREAD makes an entry published between a BLOCK timeout and the re-issued
  // XREAD fall before the new "$", so this subscriber never reads it.
  it.effect("a publish between a BLOCK timeout and the re-issued XREAD is delivered", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeRedis;
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, fake.redis)
      );
      const busA = InvalidationBus.makeSerialized(yield* make);
      const busB = InvalidationBus.makeSerialized(yield* make);

      const subscription = yield* busB.subscribe;
      expect(yield* Queue.take(fake.events)).toBe("parked");
      yield* TestClock.adjust("200 millis");
      expect(yield* Queue.take(fake.events)).toBe("timedOut");

      // The reader holds its null reply, so this publish lands after the BLOCK
      // times out, before the re-issue.
      yield* busA.publish([hint]);
      yield* Deferred.succeed(fake.releaseTimeoutReply, undefined);

      expect(yield* Queue.take(fake.events)).toBe("delivered");
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );

  // `subscribe` must not wait on Redis: its one start-position attempt is refused
  // at once, so the subscriber returns, and the reader resolves the position itself.
  // Once Redis recovers, the reader catches up and a publish reaches it.
  it.effect("subscribe returns while Redis is down, and delivers once Redis recovers", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeRedis;
      yield* fake.setDown(true);
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, fake.redis)
      );
      const busA = InvalidationBus.makeSerialized(yield* make);
      const busB = InvalidationBus.makeSerialized(yield* make);

      const subscription = yield* busB.subscribe;
      // Refused: subscribe's bounded attempt, then the reader's first step, which backs off on the TestClock.
      expect(yield* Queue.take(fake.events)).toBe("refused");
      expect(yield* Queue.take(fake.events)).toBe("refused");
      yield* fake.setDown(false);
      yield* TestClock.adjust("200 millis");
      // The reader has resolved its start position and parked, so the publish is past it.
      expect(yield* Queue.take(fake.events)).toBe("parked");
      yield* busA.publish([hint]);
      expect(yield* Queue.take(fake.events)).toBe("delivered");
      expect(yield* subscription.take).toEqual([hint]);
    }).pipe(Effect.scoped)
  );

  // A start-position lookup that never answers is abandoned at its bound, so
  // `subscribe` returns after 500 ms rather than waiting on Redis.
  it.effect("subscribe returns at its bound while Redis hangs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeRedis;
      yield* fake.setHung(true);
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, fake.redis)
      );
      const busB = InvalidationBus.makeSerialized(yield* make);
      const subscribing = yield* Effect.forkScoped(busB.subscribe, { startImmediately: true });
      yield* TestClock.adjust("500 millis");
      expect(Exit.isSuccess(yield* Fiber.await(subscribing))).toBe(true);
    }).pipe(Effect.scoped)
  );

  // The reader's back-off doubles from 200 ms and stops at the 5 s cap. Each
  // refusal is timestamped on the TestClock, so the gaps are exact.
  it.effect("reader back-off doubles from 200 ms to a 5 s cap", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeRedis;
      yield* fake.setDown(true);
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, fake.redis)
      );
      yield* InvalidationBus.makeSerialized(yield* make).subscribe;
      // subscribe's bounded attempt, then the reader's first step.
      expect(yield* Queue.take(fake.events)).toBe("refused");
      expect(yield* Queue.take(fake.events)).toBe("refused");
      for (const gap of [200, 400, 800, 1600, 3200, 5000, 5000]) {
        yield* TestClock.adjust(`${gap} millis`);
        expect(yield* Queue.take(fake.events)).toBe("refused");
      }
      const times = yield* Ref.get(fake.refusedAt);
      const origin = times[0]!;
      // subscribe's attempt at 0, the reader's first step at 0, then each retry after its back-off.
      expect(times.map((t) => t - origin)).toEqual([
        0, 0, 200, 600, 1400, 3000, 6200, 11200, 16200,
      ]);
    }).pipe(Effect.scoped)
  );

  // One warning for the outage, a debug line per further retry, and one info line
  // when Redis answers again.
  it.effect("warns once per outage, logs each retry at debug, and logs recovery at info", () => {
    const lines: Array<{ readonly level: string; readonly message: string }> = [];
    const collector = Logger.make((options) => {
      lines.push({ level: options.logLevel, message: String(options.message) });
    });
    return Effect.gen(function* () {
      const fake = yield* makeFakeRedis;
      yield* fake.setDown(true);
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, fake.redis)
      );
      yield* InvalidationBus.makeSerialized(yield* make).subscribe;
      expect(yield* Queue.take(fake.events)).toBe("refused");
      expect(yield* Queue.take(fake.events)).toBe("refused");
      yield* TestClock.adjust("200 millis");
      expect(yield* Queue.take(fake.events)).toBe("refused");
      yield* TestClock.adjust("400 millis");
      expect(yield* Queue.take(fake.events)).toBe("refused");
      yield* fake.setDown(false);
      yield* TestClock.adjust("800 millis");
      expect(yield* Queue.take(fake.events)).toBe("parked");

      const of = (level: string, text: string) =>
        lines.filter((line) => line.level === level && line.message.includes(text)).length;
      expect(of("Warn", "reader step failed; retrying with back-off")).toBe(1);
      expect(of("Debug", "reader step failed again; retrying in 400 millis")).toBe(1);
      expect(of("Debug", "reader step failed again; retrying in 800 millis")).toBe(1);
      expect(of("Info", "reader recovered after 3 failed step(s)")).toBe(1);
      expect(lines.filter((line) => line.level === "Warn")).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.withLogger(collector),
      Effect.provideService(References.MinimumLogLevel, "Debug")
    );
  });

  // The publish runs inside the sync server's uninterruptible region, so a hung
  // XADD must be dropped at its bound. TestClock moves the bound, not wall time.
  it.effect("a hung XADD is dropped at its timeout, so the publish returns", () =>
    Effect.gen(function* () {
      const redis = yield* Redis.make({
        send: (() => Effect.never) as Redis.Redis["Service"]["send"],
        subscribe: () => Effect.die(new Error("the Streams broker never subscribes")),
      });
      const broker = yield* BusBrokers.makeRedisBroker({ timeout: "2 seconds" }).pipe(
        Effect.provideService(Redis.Redis, redis)
      );
      const publishing = yield* Effect.forkScoped(
        Effect.uninterruptible(broker.publish("payload")),
        { startImmediately: true }
      );
      yield* TestClock.adjust("2 seconds");
      expect(Exit.isSuccess(yield* Fiber.await(publishing))).toBe(true);
    }).pipe(Effect.scoped)
  );
});
