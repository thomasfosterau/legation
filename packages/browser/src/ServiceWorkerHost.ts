/**
 * ServiceWorkerHost
 *
 * The recommended engine host (ADR-0010): runs the ClientEngine inside the
 * per-origin service-worker singleton — engine sync loop + tab-mirror
 * serving over a BroadcastChannel. Durable state belongs in the
 * IndexedDbClientStore layer, so a killed worker rehydrates losslessly.
 *
 * The engine stays host-agnostic: the same `run` works on the main thread
 * (the documented degraded mode) since it only needs BroadcastChannel.
 * Background Sync / Periodic Background Sync registration stays app code —
 * wire those events to `ClientEngine.push` / `ClientEngine.pull`.
 */

import { ClientEngine } from "@legation/effect";
import { Effect, Scope } from "effect";
import * as EngineHost from "./EngineHost.js";
import * as MirrorChannel from "./MirrorChannel.js";

export interface ServiceWorkerHostOptions {
  /** BroadcastChannel name shared with tab mirrors. */
  readonly channelName?: string;
}

/** The default channel name; TabMirror setups should use the same one. */
export const defaultChannelName = "legation";

/**
 * Run the host: serve tab mirrors over the broadcast channel and start the
 * engine's sync loop (pull on poke, push+pull on reconnect). Runs until
 * the scope closes.
 */
export const run = (
  options?: ServiceWorkerHostOptions
): Effect.Effect<void, never, ClientEngine.ClientEngine | Scope.Scope> =>
  Effect.gen(function* () {
    const engine = yield* ClientEngine.ClientEngine;
    const channel = yield* MirrorChannel.makeBroadcastChannel(
      options?.channelName ?? defaultChannelName
    );
    yield* EngineHost.run({ channel, engine });
    yield* engine.runSync.pipe(Effect.ignore);
  });
