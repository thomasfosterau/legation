/**
 * BusBrokers
 *
 * Concrete {@link BusBroker} implementations for the distributed
 * invalidation bus (ADR-0009). A broker is one string pub/sub channel;
 * `InvalidationBus.makeSerialized` runs the whole bus over it. These add no
 * dependency footprint (Redis ships inside `effect`; the WebSocket broker is
 * structural), so they live in core per ADR-0006.
 *
 * - `makeRedisBroker`: over Redis **Streams** (`XADD` / `XREAD BLOCK`) using
 *   `effect/persistence` Redis. Streams give durable, replayable
 *   fan-out; point every instance's subscriber at the same stream key.
 * - `makeWebSocketBroker`: over any `WebSocketLike` whose far end broadcasts
 *   every frame to all peers — the shape of a Cloudflare Durable Object
 *   relay (each Worker isolate holds a socket to the DO; the DO rebroadcasts).
 */

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { Redis } from "effect/persistence";
import type { BusBroker } from "./InvalidationBus.js";

// ─── Redis Streams broker ────────────────────────────────────────────────────

/** Options for {@link makeRedisBroker}. */
export interface RedisBrokerOptions {
  /** Stream key all instances share. Defaults to `"legation:hints"`. */
  readonly stream?: string;
  /**
   * XREAD BLOCK timeout before re-issuing. Defaults to 5 seconds. A reader XREAD with no reply
   * within this plus a fixed 2-second margin is a failed step. `0` disables that hang detection:
   * the reader parks until an entry arrives, so a dead connection parks it silently, as before.
   */
  readonly block?: Duration.Input;
  /**
   * Where a new subscriber starts reading. `"$"` (default) delivers only
   * messages published after it connects — pub/sub semantics; `"0"` replays
   * the whole stream (harmless for a bus, but unbounded without trimming).
   */
  readonly from?: "$" | "0";
  /**
   * Bound on one XADD. A publish that exceeds it is logged and dropped: the bus publishes inside
   * the sync server's uninterruptible commit-and-publish region, so a hung Redis must not hold
   * that region open. Defaults to 5 seconds.
   */
  readonly timeout?: Duration.Input;
}

/** One stream entry: `[id, [field0, value0, ...]]`. */
type StreamEntry = readonly [string, ReadonlyArray<string>];
/** One stream's slice in an XREAD reply: `[streamKey, entries]`. */
type StreamReply = readonly [string, ReadonlyArray<StreamEntry>];
/** A full XREAD reply, or null on BLOCK timeout. */
type XReadReply = ReadonlyArray<StreamReply> | null;
/** An XREVRANGE reply: the entries in range, newest first. */
type XRevRangeReply = ReadonlyArray<StreamEntry>;

const PAYLOAD_FIELD = "p";

/** Pull the payload value out of an entry's flattened field/value pairs. */
const payloadOf = (fields: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (String(fields[i]) === PAYLOAD_FIELD) return String(fields[i + 1]);
  }
  return undefined;
};

/**
 * The ID an XREAD continues from after the given XREVRANGE reply: the newest
 * entry's ID, or `0-0` for an empty stream (so the next XREAD delivers every entry).
 */
const cursorAfter = (reply: XRevRangeReply): string => {
  const [newest] = reply;
  return newest === undefined ? "0-0" : newest[0];
};

/**
 * How long `subscribe` waits for its one start-position lookup. Past it, the
 * subscription is returned anyway and the reader resolves the position itself.
 */
const START_LOOKUP_BOUND = Duration.millis(500);

/** The reader's start-position lookup did not answer within {@link START_LOOKUP_BOUND}. */
class StartLookupTimeout extends Data.TaggedError("StartLookupTimeout") {}

/**
 * The margin added to the XREAD BLOCK time to bound one reader XREAD. Redis ends a healthy idle
 * block at BLOCK, so a reply still missing at BLOCK plus this margin is a dead read (a half-open
 * connection, say), not a quiet stream.
 */
const XREAD_MARGIN_MS = 2_000;

/** A reader XREAD got no reply within its bound (see {@link XREAD_MARGIN_MS}). */
class XReadTimeout extends Data.TaggedError("XReadTimeout") {}

/** The reader's first back-off after a failed step; it doubles on each consecutive failure. */
const RETRY_BASE_MS = 200;

/** The cap on the reader's back-off. */
const RETRY_CAP_MS = 5_000;

/** Back-off before the next attempt, after `failures` consecutive failed steps (`failures >= 1`). */
const backoffMs = (failures: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (failures - 1));

/**
 * A BusBroker over Redis Streams. Captures the `Redis` service; each
 * `subscribe` forks a scoped reader looping `XREAD BLOCK`.
 *
 * `subscribe` makes one attempt at the start position (`XREVRANGE`, or `0-0`
 * for an empty stream), waiting at most 500 ms, and returns either way. If the
 * attempt answers in time, a hint published once `subscribe` returns is never
 * missed. If it fails or times out, the forked reader resolves the start
 * position on its first step and retries with back-off (200 ms, doubling,
 * capped at 5 s) until Redis answers. While Redis is unreachable, a publish that
 * races the start can be missed: it lands after `subscribe` returns but before
 * the reader resolves its start position. Delivery is best-effort (ADR-0009).
 * Each reader XREAD is bounded at its `block` time plus the margin described on
 * `block`. A call with no reply by then is a failed step: it is logged, backed off
 * and retried from the last ID seen, as a failed start lookup is, so no entry is
 * skipped. A reply of null (a normal BLOCK timeout) is a success.
 *
 * The `Redis` service's `send` must meet two properties that this bound relies on.
 * It must be interruptible: the bound interrupts a read that never replies. And
 * after an aborted `send`, it must keep replies in order on its connection, so a
 * late reply to an abandoned XREAD is never read as the answer to the next command.
 *
 * Known limit: after a `DEL` and recreate of the stream, or a Redis clock
 * stepping backwards, new IDs can fall at or below the sticky cursor and be
 * skipped until the subscriber resubscribes.
 */
export const makeRedisBroker = (
  options?: RedisBrokerOptions
): Effect.Effect<BusBroker, never, Redis.Redis> =>
  Effect.gen(function* () {
    const redis = yield* Redis.Redis;
    const stream = options?.stream ?? "legation:hints";
    const blockMillis = Math.trunc(Duration.toMillis(options?.block ?? "5 seconds"));
    const blockMs = String(blockMillis);
    const from = options?.from ?? "$";
    const timeout = options?.timeout ?? "5 seconds";

    // Bounds one reader XREAD (see XREAD_MARGIN_MS). BLOCK 0 parks until an entry
    // arrives, so no bound can tell a dead read from a quiet stream and none applies.
    const boundRead = <A>(
      read: Effect.Effect<A, Redis.RedisError>
    ): Effect.Effect<A, Redis.RedisError | XReadTimeout> =>
      blockMillis > 0
        ? read.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(blockMillis + XREAD_MARGIN_MS),
              orElse: () => Effect.fail(new XReadTimeout()),
            })
          )
        : read;

    // The start position of a subscription, read before the first XREAD. XREAD's
    // "$" re-resolves on each call, so a BLOCK timeout followed by a publish would
    // move the cursor past that entry and the subscriber would never read it; the
    // ID read here does not move. A failure is raised to the caller: `subscribe`
    // treats it as "not yet", and the reader asks again. The reader bounds this
    // lookup itself (START_LOOKUP_BOUND), so a hung Redis is a failed step too.
    const lastId = redis
      .send<XRevRangeReply>("XREVRANGE", stream, "+", "-", "COUNT", "1")
      .pipe(Effect.map(cursorAfter));

    return {
      // Best-effort: a failed or timed-out publish only delays the next pull
      // (ADR-0009), and BusBroker.publish has no error channel.
      publish: (payload) =>
        redis.send("XADD", stream, "*", PAYLOAD_FIELD, payload).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.logWarning("Redis broker: XADD timed out; publish dropped"),
          }),
          Effect.ignore
        ),
      subscribe: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string>();
        // The ID the next XREAD continues from. `from: "0"` needs no lookup. Any
        // other start gets one bounded attempt here, so a publish made right after
        // `subscribe` returns is not missed while Redis answers in time. If the
        // attempt fails or times out, the reader's first step resolves it.
        const cursor: { id: string | undefined } = { id: from === "0" ? "0" : undefined };
        if (cursor.id === undefined) {
          const first = yield* lastId.pipe(
            Effect.timeoutOption(START_LOOKUP_BOUND),
            Effect.orElseSucceed(() => Option.none<string>())
          );
          if (Option.isSome(first)) cursor.id = first.value;
        }
        // Per-subscription outage state: consecutive failed steps. The first failure
        // of an outage logs a warning, each further retry logs at debug, and the
        // first successful Redis reply after an outage logs at info.
        const outage = { failures: 0 };
        const answered = Effect.suspend(() => {
          const failures = outage.failures;
          if (failures === 0) return Effect.void;
          outage.failures = 0;
          return Effect.logInfo(`Redis broker: reader recovered after ${failures} failed step(s)`);
        });
        const failed = (error: unknown) =>
          Effect.suspend(() => {
            outage.failures += 1;
            const delay = backoffMs(outage.failures);
            const log =
              outage.failures === 1
                ? Effect.logWarning(
                    "Redis broker: reader step failed; retrying with back-off",
                    error
                  )
                : Effect.logDebug(
                    `Redis broker: reader step failed again; retrying in ${delay} millis`,
                    error
                  );
            return log.pipe(Effect.andThen(Effect.sleep(Duration.millis(delay))));
          });
        const readOnce = Effect.gen(function* () {
          if (cursor.id === undefined) {
            cursor.id = yield* lastId.pipe(
              Effect.timeoutOrElse({
                duration: START_LOOKUP_BOUND,
                orElse: () => Effect.fail(new StartLookupTimeout()),
              }),
              Effect.tap(() => answered)
            );
          }
          const reply = yield* boundRead(
            redis.send<XReadReply>("XREAD", "BLOCK", blockMs, "STREAMS", stream, cursor.id)
          ).pipe(Effect.tap(() => answered));
          if (reply === null) return;
          for (const [, entries] of reply) {
            for (const [id, fields] of entries) {
              cursor.id = id;
              const payload = payloadOf(fields);
              if (payload !== undefined) yield* Queue.offer(queue, payload);
            }
          }
        }).pipe(
          // A transient Redis error, a read with no reply (XReadTimeout), or an
          // unresolved start position must not kill the subscription: log it, back
          // off, and run the step again from the last ID seen.
          Effect.catch(failed)
        );
        yield* Effect.forkScoped(Effect.forever(readOnce));
        return { take: Queue.take(queue) };
      }),
    };
  });

// ─── WebSocket / Durable Object broker ───────────────────────────────────────

/** The minimal WebSocket surface this broker uses (browser/DO/ws-compatible). */
export interface WebSocketLike {
  readonly send: (data: string) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void
  ) => void;
}

/**
 * A BusBroker over a `WebSocketLike` whose far end rebroadcasts every frame
 * to all connected peers — the Durable Object relay pattern. `publish` sends
 * a frame; `subscribe` collects inbound string frames.
 */
export const makeWebSocketBroker = (socket: WebSocketLike): BusBroker => ({
  publish: (payload) => Effect.sync(() => socket.send(payload)),
  subscribe: Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: { readonly data: unknown }) => {
          if (P.isString(event.data)) Queue.offerUnsafe(queue, event.data);
        };
        socket.addEventListener("message", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => socket.removeEventListener("message", listener))
    );
    return { take: Queue.take(queue) };
  }),
});

// ─── BroadcastChannel broker ─────────────────────────────────────────────────

/** The minimal `BroadcastChannel` surface this broker uses. */
export interface BroadcastChannelLike {
  readonly postMessage: (data: string) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: { readonly data: unknown }) => void
  ) => void;
}

/**
 * A BusBroker over a `BroadcastChannel` — cross-context fan-out on one machine
 * (browser tabs, Node worker threads). A `BroadcastChannel` delivers to every
 * *other* channel of the same name but not the sender, so `publish` also offers
 * to this broker's own subscribers, honoring the contract's self-delivery (each
 * instance fans the hint out to its local sessions). Point every context's
 * broker at the same channel name.
 */
export const makeBroadcastChannelBroker = (
  channel: BroadcastChannelLike
): Effect.Effect<BusBroker, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queues = new Set<Queue.Queue<string>>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: { readonly data: unknown }) => {
          if (!P.isString(event.data)) return;
          for (const queue of queues) Queue.offerUnsafe(queue, event.data);
        };
        channel.addEventListener("message", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => channel.removeEventListener("message", listener))
    );
    return {
      publish: (payload) =>
        Effect.sync(() => {
          for (const queue of queues) Queue.offerUnsafe(queue, payload); // self
          channel.postMessage(payload); // other contexts
        }),
      subscribe: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<string>();
        yield* Effect.acquireRelease(
          Effect.sync(() => queues.add(queue)),
          () => Effect.sync(() => queues.delete(queue))
        );
        return { take: Queue.take(queue) };
      }),
    };
  });
