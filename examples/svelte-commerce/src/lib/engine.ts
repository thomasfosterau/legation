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
 * engine (the worker can't read the client-group cookie) and (2) pins the
 * shell's reads — subscriptions are client state, refcounted per mirror
 * by the host.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client } from "@legation/effect";
import { BroadcastMirrorChannel, ServiceWorkerHost } from "@legation/browser";
import type { Runtime } from "@legation/svelte";
import { mutators, nodes, shellReads } from "./domain.js";

export type AppRuntime = Runtime.ClientRuntime;

/** Build the tab's Client runtime once (call from the root layout). */
export const boot = (options: {
  readonly clientGroupId: string;
  readonly userId: string | undefined;
}): AppRuntime => {
  // Surface engine-host failures relayed by the worker (see service-worker.ts).
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const info = (event.data as { legationInfo?: string } | undefined)?.legationInfo;
    if (info !== undefined) console.warn(`[legation-sw] ${info}`);
  });
  const runtime = ManagedRuntime.make(
    Layer.effect(Client.Client)(
      Effect.gen(function* () {
        const channel = yield* BroadcastMirrorChannel.make(
          ServiceWorkerHost.defaultChannelName
        );
        const client = yield* Client.connect({ nodes, mutations: mutators, channel });
        // Boot-time shell pins; a failure here is a bug, not app state.
        yield* Effect.forEach(shellReads(options.userId), (read) => client.subscribe(read), {
          discard: true,
        }).pipe(Effect.orDie);
        return client;
      })
    )
  );
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
  // Touch the runtime so the Client (and its shell subscriptions) boot now.
  void runtime.runPromise(Effect.asVoid(Client.Client)).catch(() => undefined);
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__legation = runtime;
  return runtime;
};

/**
 * SSR stub runtime: the rune hooks read the runtime from context at init but
 * only *use* it inside `$effect`, which never runs on the server — SSR
 * renders come entirely from the hooks' `initial` seeds. Any server-side
 * invocation is therefore a bug, and this stub makes it loud.
 */
export const ssrStub = (): AppRuntime =>
  new Proxy({} as AppRuntime, {
    get(_target, property) {
      throw new Error(
        `engine runtime accessed during SSR (.${String(property)}) — render from initial seeds instead`
      );
    },
  });
