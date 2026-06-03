/**
 * Subscriptions
 *
 * Wiring between a `ClientTransport` and the local `SyncCache` for live
 * server-pushed updates. The server emits `Updated` / `Removed` /
 * `Invalidated` notifications for keys the client has subscribed to;
 * `runSubscriptions` consumes that stream and applies each notification to
 * the cache, so observed queries refresh automatically.
 *
 * `subscribeKeys` / `unsubscribeKeys` send the corresponding control
 * messages with generated message ids.
 */

import { Effect, Stream } from "effect";
import * as Protocol from "./Protocol.js";
import * as SyncCache from "./SyncCache.js";
import * as Transport from "./Transport.js";
import { type StoreError, type TransportError } from "./Errors.js";

let messageCounter = 0;

/**
 * Generate a unique client message id.
 */
const nextMessageId = (): string => {
  messageCounter += 1;
  return `client-msg-${messageCounter}`;
};

/**
 * Consume the transport's server messages and apply each fan-out
 * notification to the cache.
 *
 * - `Updated` → `cache.set(entry.key, entry.value, { version })`
 * - `Removed` → `cache.remove(key)`
 * - `Invalidated` → `cache.invalidate(toKeyFilter(filter))`
 * - acks and responses are ignored (they are handled where requests are sent)
 *
 * This runs until the transport's message stream ends; fork it (e.g. with
 * `Effect.forkScoped`) to run it in the background.
 */
export const runSubscriptions: Effect.Effect<
  void,
  TransportError | StoreError,
  Transport.ClientTransport | SyncCache.SyncCache
> = Effect.gen(function* () {
  const transport = yield* Transport.ClientTransport;
  const cache = yield* SyncCache.SyncCache;

  yield* Stream.runForEach(transport.messages, (message) => {
    switch (message._tag) {
      case "Updated":
        return Effect.asVoid(
          cache.set(message.entry.key, message.entry.value, { version: message.entry.version })
        );
      case "Removed":
        return Effect.asVoid(cache.remove(message.key));
      case "Invalidated":
        return cache.invalidate(Protocol.toKeyFilter(message.filter));
      default:
        // SubscribeAck / UnsubscribeAck / PushAck / PullAck / Pong /
        // ProtocolFailure are responses, not fan-out; ignore here.
        return Effect.void;
    }
  });
});

/**
 * Subscribe to keys matching a wire filter, sending a `Subscribe` message.
 */
export const subscribeKeys = (
  transport: Transport.ClientTransport,
  filter: Protocol.WireKeyFilter
): Effect.Effect<void, TransportError> =>
  transport.send({ _tag: "Subscribe", id: nextMessageId(), filter });

/**
 * Unsubscribe from keys matching a wire filter, sending an `Unsubscribe`
 * message.
 */
export const unsubscribeKeys = (
  transport: Transport.ClientTransport,
  filter: Protocol.WireKeyFilter
): Effect.Effect<void, TransportError> =>
  transport.send({ _tag: "Unsubscribe", id: nextMessageId(), filter });
