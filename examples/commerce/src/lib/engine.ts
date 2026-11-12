/**
 * Tab boot — the thin side of ADR-0010's deployment.
 *
 * The engine, its IndexedDB store, and the sync transport all live in the
 * service worker (src/service-worker.ts). A tab holds only a `Client`
 * joined to the worker's engine over the shared BroadcastChannel
 * (ADR-0022): the rune hooks read it from context, so every read and
 * mutation talks to the worker and the main thread does little besides
 * rendering.
 *
 * Boot also (1) broadcasts the config handshake that starts the worker's
 * engine (the worker can't read the client-group cookie), (2) offers the
 * page's SSR snapshot to the worker through the host-request envelope
 * (`createClient`'s `snapshot`, #146) — the worker owns the empty-store
 * gate, so a returning visitor's replica is never touched — and (3) pins
 * the shell's reads once the offer is settled (subscriptions are client
 * state, refcounted per mirror by the host; a registration makes the host
 * pull, which would turn the snapshot away).
 *
 * `bootMainThread` is the dev-mode alternative (`?host=main`,
 * `+layout.svelte`): no service worker at all — `ElectedHost.run` owns the
 * engine on this tab directly (ADR-0010's no-service-worker fallback, #119),
 * so the topology actually runs somewhere in this repo (see `lib/host.ts`'s
 * `bootElected`).
 */
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Hydration } from "@thomasfosterau/legation";
import { BroadcastMirrorChannel, type ElectedHost, ServiceWorkerHost } from "@thomasfosterau/legation-browser";
import {
  type ClientRuntime,
  type ConnectedClientHandle,
  createClient,
} from "@thomasfosterau/legation-svelte";
import { mutators, nodes, shellReads } from "./domain.js";
import { bootElected } from "./host.js";

export type AppRuntime = ClientRuntime;

/**
 * Build the tab's Client once (call from the root layout): a mirror of the
 * worker's engine, offered the page's SSR snapshot (#146) before the shell's
 * pins are made. The worker hydrates its replica with it only when the
 * replica is empty and has not pulled; the handle's `hydration` says what it
 * answered, and no answer needs any action here.
 */
export const boot = (options: {
  readonly clientGroupId: string;
  readonly userId: string | undefined;
  readonly snapshot: Hydration.Snapshot | undefined;
}): ConnectedClientHandle => {
  // Surface engine-host failures relayed by the worker (see service-worker.ts).
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const info = (event.data as { legationInfo?: string } | undefined)?.legationInfo;
    if (info !== undefined) console.warn(`[legation-sw] ${info}`);
  });
  const client = createClient({
    nodes,
    mutations: mutators,
    channel: BroadcastMirrorChannel.make(ServiceWorkerHost.defaultChannelName),
    snapshot: options.snapshot,
    // A first visit's worker is still installing when this tab boots: keep
    // offering the snapshot until it answers (it holds its first pull for
    // it, `lib/host.ts`). The hooks render from their seeds meanwhile.
    hydrateTimeout: "15 seconds",
    // Boot-time shell pins, made once the snapshot is settled.
    subscribe: shellReads(options.userId),
  });
  // Wake the worker's engine (idempotent — the first handshake wins, and a
  // worker that activates AFTER this tab still hears a later repeat; its
  // HostReady answer replays this tab's registrations).
  const config = new BroadcastChannel("legation-config");
  const announce = () => config.postMessage({ clientGroupId: options.clientGroupId });
  announce();
  const timer = setInterval(announce, 2000);
  setTimeout(() => {
    clearInterval(timer);
    config.close();
  }, 20_000);
  // Touch the runtime so the Client (the snapshot offer, then the shell pins) boots now.
  void client.runtime.runPromise(Effect.void).catch(() => undefined);
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__legation = client.runtime;
  return client;
};

/**
 * The dev-mode, no-service-worker alternative to {@link boot} (#133 item 6):
 * this tab elects itself leader (`navigator.locks`) and owns the engine
 * directly instead of joining the service worker's — the shipped fallback
 * topology for environments without service-worker support (ADR-0010, #119).
 * Returns the `role` stream alongside the runtime purely for a debug badge;
 * `+layout.svelte` never branches application logic on it.
 */
export const bootMainThread = (options: {
  readonly clientGroupId: string;
  readonly userId: string | undefined;
}): { readonly runtime: AppRuntime; readonly role: Stream.Stream<ElectedHost.Role> } => {
  const { runtime, role } = bootElected({
    clientGroupId: options.clientGroupId,
    syncOrigin: location.origin,
    userId: options.userId,
  });
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__legation = runtime;
  return { runtime, role };
};
