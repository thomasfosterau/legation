/**
 * Bus broker tests: the WebSocket (Durable Object relay) broker and the
 * Redis Streams broker each carry a ChangeHint between two serialized buses.
 */
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, PubSub, Queue, Ref } from "effect";
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
  let seq = 0;
  let down = false;

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
  // current `down` state, not the state when the command was built.
  const send = (<A>(command: string, ...args: ReadonlyArray<string>): Effect.Effect<A, Error> =>
    Effect.suspend((): Effect.Effect<unknown, Error> => {
      if (down) {
        return Queue.offer(events, "refused").pipe(
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

  // `Redis.make` requires pub/sub too; the Streams broker only ever sends
  // commands, so a subscribe here is a test bug, not a code path.
  const subscribe = () => Effect.die(new Error("the Streams broker never subscribes"));

  return {
    redis: yield* Redis.make({ send, subscribe }),
    events,
    readerParked,
    releaseTimeoutReply,
    setDown,
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

  // `subscribe` must not wait on Redis: the reader resolves its start position
  // itself, so a subscriber made while Redis is down returns at once. Once Redis
  // recovers, the reader catches up and a publish reaches it.
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
      // The reader's start-position lookup is refused, then backs off on the TestClock.
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
