/**
 * SyncHub
 *
 * The central server engine. It accepts connected clients, applies their
 * pushed mutations write-through to the `ServerStore`, and fans out the
 * resulting changes to every other subscribed session.
 *
 * ```text
 *   client A ─push─▶ ┌─────────┐ ─set──▶ ServerStore (source of truth)
 *                    │ SyncHub │
 *   client B ◀updated┤         │◀── publish()/remove()/invalidate()
 *   client C ◀updated└─────────┘     (server-initiated writes)
 * ```
 *
 * Write-through semantics: a push first runs an optimistic-concurrency check
 * (if the client supplied a `baseVersion` and it no longer matches the
 * store's current version, the mutation is reported as a `Conflict` with the
 * server's authoritative entry), then writes to the store and notifies
 * subscribers. The pushing session is intentionally excluded from its own
 * fan-out — it already learns the outcome from the `PushAck`.
 */

import { Context, Effect, Layer, Option, Stream } from "effect";
import * as Protocol from "./Protocol.js";
import * as SyncKey from "./SyncKey.js";
import type * as Transport from "./Transport.js";
import { type StoreError, type TransportError } from "./Errors.js";
import { ServerStore } from "./ServerStore.js";
import type { StoredEntry } from "./ServerStore.js";
import { SessionRegistry } from "./Sessions.js";
import type { Session } from "./Sessions.js";

/**
 * The central server engine service.
 */
export interface SyncHub {
  /**
   * Handle one connected client for the lifetime of its connection:
   * register the session, dispatch each incoming `ClientMessage`, and
   * unregister the session when the message stream ends. This effect runs
   * until the connection closes.
   */
  readonly handleConnection: (
    connection: Transport.ServerConnection
  ) => Effect.Effect<void, TransportError | StoreError>;
  /**
   * Server-initiated write (e.g. from a REST handler): write the value
   * through to the store and fan out `Updated` to all subscribed sessions.
   */
  readonly publish: (
    key: SyncKey.SyncKey,
    value: unknown
  ) => Effect.Effect<Protocol.WireEntry, StoreError>;
  /** Remove a key from the store and fan out `Removed` to subscribers. */
  readonly remove: (key: SyncKey.SyncKey) => Effect.Effect<void, StoreError>;
  /** Fan out `Invalidated` to sessions subscribed to overlapping keys. */
  readonly invalidate: (filter: Protocol.WireKeyFilter) => Effect.Effect<void>;
  /** Number of currently connected sessions. */
  readonly connectedSessions: Effect.Effect<number>;
}

/**
 * Service key for the server engine.
 */
export const SyncHub = Context.Service<SyncHub>("@thomasfosterau/effect-sync-core/SyncHub");

const toWireEntry = (entry: StoredEntry): Protocol.WireEntry => ({
  key: entry.key,
  value: entry.value,
  version: entry.version,
  updatedAt: entry.updatedAt,
});

/**
 * Build a `SyncHub` from the `ServerStore` and `SessionRegistry` in context.
 */
export const make: Effect.Effect<SyncHub, never, ServerStore | SessionRegistry> = Effect.gen(
  function* () {
    const store = yield* ServerStore;
    const registry = yield* SessionRegistry;

    // Fan out a message to a set of sessions concurrently, ignoring failures
    // so a single dead client cannot break delivery to the others.
    const fanOut = (
      sessions: ReadonlyArray<Session>,
      message: Protocol.ServerMessage
    ): Effect.Effect<void> =>
      Effect.forEach(sessions, (session) => Effect.ignore(session.connection.send(message)), {
        concurrency: "unbounded",
        discard: true,
      });

    const applyMutation = (
      mutation: Protocol.PushMutation,
      excludeSessionId: string
    ): Effect.Effect<Protocol.PushResult, StoreError> =>
      Effect.gen(function* () {
        const current = yield* store.get(mutation.key);

        // Optimistic-concurrency check: a stale base version against an
        // existing key is a conflict.
        if (
          mutation.baseVersion !== undefined &&
          Option.isSome(current) &&
          current.value.version !== mutation.baseVersion
        ) {
          return {
            _tag: "Conflict",
            mutationId: mutation.mutationId,
            key: mutation.key,
            serverEntry: toWireEntry(current.value),
          } satisfies Protocol.PushResult;
        }

        const stored = yield* store.set(mutation.key, mutation.input);
        const entry = toWireEntry(stored);

        // Fan out to every OTHER subscribed session.
        const subscribers = yield* registry.subscribers(mutation.key);
        const others = subscribers.filter((session) => session.sessionId !== excludeSessionId);
        yield* fanOut(others, { _tag: "Updated", entry });

        return {
          _tag: "Applied",
          mutationId: mutation.mutationId,
          entry,
        } satisfies Protocol.PushResult;
      });

    const dispatch = (
      connection: Transport.ServerConnection,
      message: Protocol.ClientMessage
    ): Effect.Effect<void, TransportError | StoreError> => {
      switch (message._tag) {
        case "Subscribe":
          return registry
            .addSubscription(connection.sessionId, message.filter)
            .pipe(Effect.andThen(connection.send({ _tag: "SubscribeAck", id: message.id })));

        case "Unsubscribe":
          return registry
            .removeSubscription(connection.sessionId, message.filter)
            .pipe(Effect.andThen(connection.send({ _tag: "UnsubscribeAck", id: message.id })));

        case "Ping":
          return connection.send({ _tag: "Pong", id: message.id });

        case "Pull":
          return Effect.gen(function* () {
            const entries: Array<Protocol.WireEntry> = [];
            for (const key of message.keys) {
              const stored = yield* store.get(key);
              if (Option.isSome(stored)) {
                entries.push(toWireEntry(stored.value));
              }
            }
            yield* connection.send({ _tag: "PullAck", id: message.id, entries });
          });

        case "Push":
          return Effect.gen(function* () {
            const results = yield* Effect.forEach(message.mutations, (mutation) =>
              applyMutation(mutation, connection.sessionId)
            );
            yield* connection.send({ _tag: "PushAck", id: message.id, results });
          });
      }
    };

    const handleConnection = (
      connection: Transport.ServerConnection
    ): Effect.Effect<void, TransportError | StoreError> =>
      Effect.gen(function* () {
        yield* registry.register(connection);
        yield* Stream.runForEach(connection.messages, (message) => dispatch(connection, message));
      }).pipe(Effect.ensuring(registry.unregister(connection.sessionId)));

    const publish = (
      key: SyncKey.SyncKey,
      value: unknown
    ): Effect.Effect<Protocol.WireEntry, StoreError> =>
      Effect.gen(function* () {
        const stored = yield* store.set(key, value);
        const entry = toWireEntry(stored);
        const subscribers = yield* registry.subscribers(key);
        yield* fanOut(subscribers, { _tag: "Updated", entry });
        return entry;
      });

    const remove = (key: SyncKey.SyncKey): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        const removed = yield* store.remove(key);
        const version = Option.isSome(removed) ? removed.value.version : 0;
        const subscribers = yield* registry.subscribers(key);
        yield* fanOut(subscribers, { _tag: "Removed", key, version });
      });

    const invalidate = (filter: Protocol.WireKeyFilter): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Conservative fan-out: notify every session. A session learns which
        // of its own keys are affected by matching the filter client-side.
        const sessions = yield* registry.sessions;
        yield* fanOut(sessions, { _tag: "Invalidated", filter });
      });

    const connectedSessions: Effect.Effect<number> = Effect.map(
      registry.sessions,
      (sessions) => sessions.length
    );

    return {
      handleConnection,
      publish,
      remove,
      invalidate,
      connectedSessions,
    } satisfies SyncHub;
  }
);

/**
 * A layer providing the server engine, requiring a `ServerStore` and a
 * `SessionRegistry`.
 */
export const layer: Layer.Layer<SyncHub, never, ServerStore | SessionRegistry> =
  Layer.effect(SyncHub)(make);
