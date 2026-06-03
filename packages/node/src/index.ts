/**
 * @thomasfosterau/effect-sync-node
 *
 * Node-runtime adapters for the effect-sync engine. This package contains the
 * runtime code that depends on Node-only APIs (the `ws` package), kept out of
 * the runtime-agnostic core per ADR-0006.
 *
 * - **WebSocketServer**: a server-side WebSocket transport that accepts client
 *   connections and feeds them into a `SyncHub`.
 */

export * as WebSocketServer from "./WebSocketServer.js";
