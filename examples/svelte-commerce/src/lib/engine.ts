/**
 * Tab boot — the thin side of ADR-0010's deployment.
 *
 * The engine, its IndexedDB store, and the sync transport all live in the
 * service worker (src/service-worker.ts). A tab holds only a `TabMirror`
 * over the shared BroadcastChannel: the bindings' runtime provides it as
 * the `ClientView`, so every hook — queries, aggregates, named queries,
 * auto-subscribing joins, mutations — talks to the worker and the main
 * thread does little besides rendering.
 *
 * Boot also (1) broadcasts the config handshake that starts the worker's
 * engine (the worker can't read the client-group cookie) and (2) registers
 * the shell's subsets — subscriptions are client state, refcounted per tab
 * by the host.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { ClientView } from "@legation/effect";
import { MirrorChannel, ServiceWorkerHost, TabMirror } from "@legation/browser";
import type { EffectSyncRuntime } from "@legation/svelte";
import { mutators, shellSubsets } from "./domain.js";

export type AppRuntime = EffectSyncRuntime;

/** Build the tab's mirror runtime once (call from the root layout). */
export const boot = (options: {
  readonly clientGroupId: string;
  readonly userId: string | undefined;
}): AppRuntime => {
  const runtime = ManagedRuntime.make(
    Layer.effect(ClientView.ClientView)(
      Effect.gen(function* () {
        const channel = yield* MirrorChannel.makeBroadcastChannel(
          ServiceWorkerHost.defaultChannelName
        );
        // TabMirror satisfies ClientView structurally (ADR-0021).
        return yield* TabMirror.make({ channel, mutators });
      })
    )
  );
  // Wake the worker's engine (idempotent — the first handshake wins), then
  // register this tab's shell subsets with it.
  const config = new BroadcastChannel("legation-config");
  config.postMessage({ clientGroupId: options.clientGroupId });
  config.close();
  void runtime
    .runPromise(
      Effect.flatMap(ClientView.ClientView, (view) =>
        Effect.forEach(shellSubsets(options.userId), (subset) => view.subscribe(subset), {
          discard: true,
        })
      )
    )
    .catch(() => undefined);
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

/**
 * Register the service worker in dev. Production registration is
 * SvelteKit's own (it emits and registers `service-worker.js` in builds);
 * dev needs the documented manual snippet with `type: "module"` because the
 * worker is served untransformed-for-classic-workers by Vite.
 * https://svelte.dev/docs/kit/service-workers#During-development
 */
export const registerDevServiceWorker = (): void => {
  if (import.meta.env.DEV && "serviceWorker" in navigator) {
    void navigator.serviceWorker
      .register("/service-worker.js", { type: "module" })
      .catch(() => undefined);
  }
};
