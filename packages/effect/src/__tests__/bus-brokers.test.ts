/**
 * Bus broker tests: the WebSocket (Durable Object relay) broker and the
 * Redis Streams broker each carry a ChangeHint between two serialized buses.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, PubSub, Ref } from "effect";
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
 * A blocking in-memory fake of the Redis commands the broker uses: XADD
 * appends to a stream and signals; XREAD BLOCK resolves "$" to the current
 * length once, then parks until a new entry arrives or the block times out.
 */
const makeFakeRedis = Effect.gen(function* () {
  const entries = yield* Ref.make<Array<{ readonly id: string; readonly payload: string }>>([]);
  const signal = yield* PubSub.unbounded<void>();
  let seq = 0;

  const send = (<A>(command: string, ...args: ReadonlyArray<string>): Effect.Effect<A> => {
    if (command === "XADD") {
      const payload = args[3]!;
      seq += 1;
      const id = `${seq}-0`;
      return Ref.update(entries, (es) => [...es, { id, payload }]).pipe(
        Effect.andThen(PubSub.publish(signal, undefined)),
        Effect.as(id as unknown as A)
      );
    }
    // XREAD BLOCK <ms> STREAMS <stream> <lastId>
    const blockMs = Number(args[1]);
    const stream = args[3]!;
    const lastId = args[4]!;
    return Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(signal);
        const all = yield* Ref.get(entries);
        const start = lastId === "$" ? all.length : all.findIndex((e) => e.id === lastId) + 1;
        const loop = (): Effect.Effect<A> =>
          Effect.gen(function* () {
            const slice = (yield* Ref.get(entries)).slice(start);
            if (slice.length > 0) {
              const reply = [[stream, slice.map((e) => [e.id, ["p", e.payload]])]];
              return reply as unknown as A;
            }
            const outcome = yield* Effect.race(
              PubSub.take(subscription).pipe(Effect.as("signal" as const)),
              Effect.sleep(Duration.millis(blockMs)).pipe(Effect.as("timeout" as const))
            );
            return outcome === "timeout" ? (null as unknown as A) : yield* loop();
          });
        return yield* loop();
      })
    );
  }) as Redis.Redis["Service"]["send"];

  // `Redis.make` requires pub/sub too; the Streams broker only ever sends
  // commands, so a subscribe here is a test bug, not a code path.
  const subscribe = () => Effect.die(new Error("the Streams broker never subscribes"));

  return yield* Redis.make({ send, subscribe });
});

describe("makeRedisBroker (Redis Streams)", () => {
  // Real clock: the reader's XREAD BLOCK and the "$" start race resolve in
  // wall time exactly as they would against a real Redis.
  it.live("carries a hint between two buses over a shared stream", () =>
    Effect.gen(function* () {
      const redis = yield* makeFakeRedis;
      const make = BusBrokers.makeRedisBroker({ stream: "test:hints", block: "200 millis" }).pipe(
        Effect.provideService(Redis.Redis, redis)
      );
      const busA = InvalidationBus.makeSerialized(yield* make);
      const busB = InvalidationBus.makeSerialized(yield* make);

      // Subscribe first ("$" = only future); let the reader park on XREAD,
      // then publish on the other bus.
      const subscription = yield* busB.subscribe;
      yield* Effect.sleep("40 millis");
      yield* busA.publish([hint]);
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
