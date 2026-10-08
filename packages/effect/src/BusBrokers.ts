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

import { Duration, Effect, Queue, Scope } from "effect";
import { Redis } from "effect/persistence";
import type { BusBroker } from "./InvalidationBus.js";

// ─── Redis Streams broker ────────────────────────────────────────────────────

/** Options for {@link makeRedisBroker}. */
export interface RedisBrokerOptions {
  /** Stream key all instances share. Defaults to `"legation:hints"`. */
  readonly stream?: string;
  /** XREAD BLOCK timeout before re-issuing. Defaults to 5 seconds. */
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
 * A BusBroker over Redis Streams. Captures the `Redis` service; each
 * `subscribe` forks a scoped reader looping `XREAD BLOCK`.
 */
export const makeRedisBroker = (
  options?: RedisBrokerOptions
): Effect.Effect<BusBroker, never, Redis.Redis> =>
  Effect.gen(function* () {
    const redis = yield* Redis.Redis;
    const stream = options?.stream ?? "legation:hints";
    const blockMs = String(Math.trunc(Duration.toMillis(options?.block ?? "5 seconds")));
    const from = options?.from ?? "$";
    const timeout = options?.timeout ?? "5 seconds";

    // The ID an XREAD starts from. Resolved once per subscription, before the
    // reader forks, so every publish after `subscribe` returns lands past it.
    // XREAD's "$" re-resolves on each call, so a BLOCK timeout followed by a
    // publish would move the cursor past that entry and the subscriber would
    // never read it. XREVRANGE reads the last ID without blocking; a Redis error
    // backs off and retries, as the reader does, so subscribe still completes.
    const lastId: Effect.Effect<string> = redis
      .send<XRevRangeReply>("XREVRANGE", stream, "+", "-", "COUNT", "1")
      .pipe(
        Effect.map(cursorAfter),
        Effect.catch(() => Effect.sleep("200 millis").pipe(Effect.andThen(lastId)))
      );

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
        // Resolve the start position once, before the reader forks (see `lastId`).
        const cursor: { id: string } = { id: from === "0" ? "0" : yield* lastId };
        const readOnce = Effect.gen(function* () {
          const reply = yield* redis.send<XReadReply>(
            "XREAD",
            "BLOCK",
            blockMs,
            "STREAMS",
            stream,
            cursor.id
          );
          if (reply === null) return;
          for (const [, entries] of reply) {
            for (const [id, fields] of entries) {
              cursor.id = id;
              const payload = payloadOf(fields);
              if (payload !== undefined) yield* Queue.offer(queue, payload);
            }
          }
        }).pipe(
          // A transient Redis error must not kill the subscription; back off.
          Effect.catch(() => Effect.sleep("200 millis"))
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
          if (typeof event.data === "string") Queue.offerUnsafe(queue, event.data);
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
          if (typeof event.data !== "string") return;
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
