/**
 * ServiceWorkerHost
 *
 * The recommended engine host (ADR-0010): runs the ClientEngine inside the
 * per-origin service-worker singleton — engine sync loop + mirror
 * serving over a BroadcastChannel. Durable state belongs in the
 * IndexedDbClientStore layer, so a killed worker rehydrates losslessly.
 *
 * The engine stays host-agnostic: the same `run` works on the main thread
 * (the documented degraded mode) since it only needs BroadcastChannel.
 * Background Sync / Periodic Background Sync registration stays app code —
 * wire those events to `ClientEngine.push` / `ClientEngine.pull`.
 *
 * To evict HTTP-cache entries as collection changes land, fork
 * `HttpCacheInvalidation.invalidateOnChanges` alongside `run` in the same
 * scope — kept out of the host so it stays an opt-in composition:
 *
 * ```ts
 * yield* ServiceWorkerHost.run();
 * yield* HttpCacheInvalidation.invalidateOnChanges({
 *   store,
 *   changes: HttpCacheInvalidation.collectionChanges(engine.engineEvents),
 * });
 * ```
 */

import type { Client, Collection, Node } from "@legation/effect";
import { ClientEngine, EngineHost } from "@legation/effect/internal";
import { Effect, Scope } from "effect";
import * as BroadcastMirrorChannel from "./BroadcastMirrorChannel.js";

export interface ServiceWorkerHostOptions {
  /** BroadcastChannel name shared with the mirrors it serves. */
  readonly channelName?: string;
  /**
   * The collection registry mirrors' `related` registrations resolve against
   * (forwarded to {@link EngineHost.run}). Pass it whenever mirrors use
   * relational reads.
   */
  readonly registry?: Collection.CollectionRegistry;
  /**
   * The node graph and URL-keyed reads for `SubscribeUrl` registrations
   * (#159): a page with no `Client` posts `{ _tag: "SubscribeUrl",
   * mirrorId, url }` on the channel and the host pins the URL's windows
   * under that id — forwarded to {@link EngineHost.run}. Build `urls` with
   * `JsonApiQuery.urlReads(nodes)` from `@legation/jsonapi`.
   */
  readonly nodes?: Node.NodeRegistry;
  readonly urls?: Client.UrlReads;
}

/** The default channel name; Mirror setups should use the same one. */
export const defaultChannelName = "legation";

/**
 * Run the host: serve mirrors over the broadcast channel and start the
 * engine's sync loop (pull on poke, push+pull on reconnect). NEVER returns —
 * both the host and `runSync` fork their fibers into the surrounding scope,
 * so returning would let a caller's `Effect.scoped` tear the whole host down
 * immediately. Interrupt it / close the scope to stop serving.
 */
export const run = (
  options: ServiceWorkerHostOptions = {}
): Effect.Effect<never, never, ClientEngine.ClientEngine | Scope.Scope> =>
  Effect.gen(function* () {
    const { channelName = defaultChannelName, registry, nodes, urls } = options;
    const engine = yield* ClientEngine.ClientEngine;
    const channel = yield* BroadcastMirrorChannel.make(channelName);
    yield* EngineHost.run({
      channel,
      engine,
      ...(registry === undefined ? {} : { registry }),
      ...(nodes === undefined ? {} : { nodes }),
      ...(urls === undefined ? {} : { urls }),
    });
    yield* engine.runSync.pipe(Effect.ignore);
    return yield* Effect.never;
  });
