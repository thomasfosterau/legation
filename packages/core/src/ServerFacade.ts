/**
 * Facade
 *
 * A promise-based facade over the Effect-native `SyncHub`, for embedding the
 * sync server in non-Effect runtimes (Express/Fastify handlers, plain
 * WebSocket servers, serverless functions). It wires the default in-memory
 * layers and exposes promise-returning methods, hiding Effect entirely.
 *
 * For full control over the backing store or layer composition, use the
 * Effect-native `SyncHub` service directly.
 */

import { Effect, Layer } from "effect";
import * as PromiseFacade from "./PromiseFacade.js";
import * as Protocol from "./Protocol.js";
import * as SyncKey from "./SyncKey.js";
import type * as Transport from "./Transport.js";
import * as ServerStore from "./ServerStore.js";
import * as Sessions from "./Sessions.js";
import * as SyncHub from "./SyncHub.js";

/**
 * A promise-based sync server, suitable for non-Effect host code.
 */
export interface SyncServer {
  /**
   * Drive one connected client for the lifetime of its connection. The
   * returned promise resolves when the connection closes.
   */
  readonly handleConnection: (connection: Transport.ServerConnection) => Promise<void>;
  /** Server-initiated write-through, fanning out to all subscribers. */
  readonly publish: (key: SyncKey.SyncKey, value: unknown) => Promise<Protocol.WireEntry>;
  /** Remove a key and fan out `Removed`. */
  readonly remove: (key: SyncKey.SyncKey) => Promise<void>;
  /** Fan out an invalidation to subscribed sessions. */
  readonly invalidate: (filter: Protocol.WireKeyFilter) => Promise<void>;
  /** Number of currently connected sessions. */
  readonly connectedSessions: () => Promise<number>;
  /** Tear down the runtime and any in-flight connection handling. */
  readonly dispose: () => Promise<void>;
}

const layer = SyncHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ServerStore.memoryLayer, Sessions.layer))
);

/**
 * Build a promise-based sync server backed by the default in-memory layers.
 *
 * ```ts
 * const server = makeSyncServer();
 * await server.handleConnection(connection);
 * await server.publish(["users", "1"], { name: "Ada" });
 * await server.dispose();
 * ```
 */
export const makeSyncServer = (): SyncServer => {
  const facade = PromiseFacade.make(layer);

  const withHub = <A, E>(
    f: (hub: SyncHub.SyncHub) => Effect.Effect<A, E, never>
  ): Effect.Effect<A, E, SyncHub.SyncHub> => Effect.flatMap(Effect.service(SyncHub.SyncHub), f);

  return {
    handleConnection: (connection) =>
      facade.run(withHub((hub) => hub.handleConnection(connection))),
    publish: (key, value) => facade.run(withHub((hub) => hub.publish(key, value))),
    remove: (key) => facade.run(withHub((hub) => hub.remove(key))),
    invalidate: (filter) => facade.run(withHub((hub) => hub.invalidate(filter))),
    connectedSessions: () => facade.run(withHub((hub) => hub.connectedSessions)),
    dispose: () => facade.dispose(),
  };
};
