/**
 * Sessions
 *
 * The registry of connected clients. Each connected client is a `Session`
 * pairing its `ServerConnection` with the set of key filters it has
 * subscribed to. The hub consults the registry to decide which sessions
 * should receive a given fan-out notification.
 *
 * The registry is purely in-memory and process-local: it holds live
 * connection handles, which cannot be serialized. Multi-process fan-out is
 * the transport layer's concern (e.g. a shared pub/sub bus feeding each
 * process's local registry).
 */

import { Context, Effect, Layer, Ref } from "effect";
import * as Protocol from "./Protocol.js";
import * as SyncKey from "./SyncKey.js";
import type * as Transport from "./Transport.js";

/**
 * One connected client tracked by the registry.
 */
export interface Session {
  /** Unique id of this connection/session (from the underlying connection). */
  readonly sessionId: string;
  /** The live connection handle for sending messages to this client. */
  readonly connection: Transport.ServerConnection;
  /** The key filters this client is currently subscribed to. */
  readonly subscriptions: ReadonlyArray<Protocol.WireKeyFilter>;
}

/**
 * The connected-client session registry service.
 */
export interface SessionRegistry {
  /** Register a freshly connected client and return its session. */
  readonly register: (connection: Transport.ServerConnection) => Effect.Effect<Session>;
  /** Remove a session (e.g. on disconnect). No-op when unknown. */
  readonly unregister: (sessionId: string) => Effect.Effect<void>;
  /** Add a subscription filter to a session. No-op when unknown. */
  readonly addSubscription: (
    sessionId: string,
    filter: Protocol.WireKeyFilter
  ) => Effect.Effect<void>;
  /**
   * Remove a subscription filter from a session, matching by equal JSON
   * representation. No-op when unknown.
   */
  readonly removeSubscription: (
    sessionId: string,
    filter: Protocol.WireKeyFilter
  ) => Effect.Effect<void>;
  /** Every currently-registered session. */
  readonly sessions: Effect.Effect<ReadonlyArray<Session>>;
  /** Sessions with at least one filter matching `key`. */
  readonly subscribers: (key: SyncKey.SyncKey) => Effect.Effect<ReadonlyArray<Session>>;
}

/**
 * Service key for the session registry.
 */
export const SessionRegistry = Context.Service<SessionRegistry>(
  "@thomasfosterau/effect-sync-core/SessionRegistry"
);

const filterKey = (filter: Protocol.WireKeyFilter): string => JSON.stringify(filter);

/**
 * Construct a `SessionRegistry` backed by a `Ref<Map>` keyed by session id.
 */
export const make: Effect.Effect<SessionRegistry> = Effect.gen(function* () {
  const sessionsRef = yield* Ref.make(new Map<string, Session>());

  const register = (connection: Transport.ServerConnection): Effect.Effect<Session> =>
    Ref.modify(sessionsRef, (map) => {
      const session: Session = {
        sessionId: connection.sessionId,
        connection,
        subscriptions: [],
      };
      const next = new Map(map);
      next.set(connection.sessionId, session);
      return [session, next];
    });

  const unregister = (sessionId: string): Effect.Effect<void> =>
    Ref.update(sessionsRef, (map) => {
      if (!map.has(sessionId)) return map;
      const next = new Map(map);
      next.delete(sessionId);
      return next;
    });

  const addSubscription = (
    sessionId: string,
    filter: Protocol.WireKeyFilter
  ): Effect.Effect<void> =>
    Ref.update(sessionsRef, (map) => {
      const session = map.get(sessionId);
      if (session === undefined) return map;
      const target = filterKey(filter);
      // Avoid duplicate subscriptions with the same JSON representation.
      if (session.subscriptions.some((existing) => filterKey(existing) === target)) {
        return map;
      }
      const next = new Map(map);
      next.set(sessionId, {
        ...session,
        subscriptions: [...session.subscriptions, filter],
      });
      return next;
    });

  const removeSubscription = (
    sessionId: string,
    filter: Protocol.WireKeyFilter
  ): Effect.Effect<void> =>
    Ref.update(sessionsRef, (map) => {
      const session = map.get(sessionId);
      if (session === undefined) return map;
      const target = filterKey(filter);
      const next = new Map(map);
      next.set(sessionId, {
        ...session,
        subscriptions: session.subscriptions.filter((existing) => filterKey(existing) !== target),
      });
      return next;
    });

  const sessions: Effect.Effect<ReadonlyArray<Session>> = Effect.map(Ref.get(sessionsRef), (map) =>
    Array.from(map.values())
  );

  const subscribers = (key: SyncKey.SyncKey): Effect.Effect<ReadonlyArray<Session>> =>
    Effect.map(Ref.get(sessionsRef), (map) =>
      Array.from(map.values()).filter((session) =>
        session.subscriptions.some((filter) => Protocol.matches(key, filter))
      )
    );

  return {
    register,
    unregister,
    addSubscription,
    removeSubscription,
    sessions,
    subscribers,
  } satisfies SessionRegistry;
});

/**
 * A layer providing the in-memory session registry.
 */
export const layer: Layer.Layer<SessionRegistry> = Layer.effect(SessionRegistry)(make);
