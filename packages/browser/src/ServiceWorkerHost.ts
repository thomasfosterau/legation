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
 *
 * A worker that also answers JSON:API `GET`s from the replica (the façade,
 * ADR-0029 — `JsonApiFacade` in `@legation/jsonapi`) needs what the host
 * knows: {@link start} serves exactly as {@link run} does and returns the
 * {@link Host} — the engine and the registrations the host holds on the
 * mirrors' behalf, the ledger the façade's coverage check scans — then
 * leaves the caller to keep the scope open.
 */

import type { Client, Collection, Node } from "@legation/effect";
import { ClientEngine, type Coverage, EngineHost } from "@legation/effect/internal";
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

/** The serving host: the engine it serves and what it holds for the mirrors. */
export interface Host {
  /** The engine the host serves — the replica a façade reads (`ClientView.fromEngine(engine)`). */
  readonly engine: ClientEngine.ClientEngine;
  /**
   * The registrations the host holds on its mirrors' behalf at this moment
   * (`EngineHost.Host.registrations`): the ledger a façade's coverage check
   * scans, `Coverage.coverageOf(nodes, host.registrations)`.
   */
  readonly registrations: Effect.Effect<ReadonlyArray<Coverage.Subscription>>;
}

/**
 * Start the host: serve mirrors over the broadcast channel and start the
 * engine's sync loop (pull on poke, push+pull on reconnect), then return
 * the {@link Host}. Both the host and `runSync` fork their fibers into the
 * surrounding scope, so the caller must keep that scope open for as long
 * as it serves (`Effect.never`, as {@link run} does); closing it stops
 * serving.
 */
export const start = (
  options: ServiceWorkerHostOptions = {}
): Effect.Effect<Host, never, ClientEngine.ClientEngine | Scope.Scope> =>
  Effect.gen(function* () {
    const { channelName = defaultChannelName, registry, nodes, urls } = options;
    const engine = yield* ClientEngine.ClientEngine;
    const channel = yield* BroadcastMirrorChannel.make(channelName);
    const host = yield* EngineHost.run({
      channel,
      engine,
      ...(registry === undefined ? {} : { registry }),
      ...(nodes === undefined ? {} : { nodes }),
      ...(urls === undefined ? {} : { urls }),
    });
    yield* engine.runSync.pipe(Effect.ignore);
    return { engine, registrations: host.registrations };
  });

/**
 * Run the host: {@link start}, then serve forever. NEVER returns — both the
 * host and `runSync` fork their fibers into the surrounding scope, so
 * returning would let a caller's `Effect.scoped` tear the whole host down
 * immediately. Interrupt it / close the scope to stop serving.
 */
export const run = (
  options: ServiceWorkerHostOptions = {}
): Effect.Effect<never, never, ClientEngine.ClientEngine | Scope.Scope> =>
  start(options).pipe(Effect.andThen(Effect.never));
