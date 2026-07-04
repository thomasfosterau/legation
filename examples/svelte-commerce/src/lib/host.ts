/**
 * The engine host, host-agnostically: the same composition serves
 * mirrors from the service worker (production — see src/service-worker.ts)
 * and from a dev tab's main thread (Vite's dev service workers can't
 * evaluate module graphs containing dynamic imports, so `+layout.svelte`
 * runs this under a `navigator.locks` leader election instead — ADR-0010's
 * documented degraded mode, and a live demonstration that the host only
 * needs a BroadcastChannel).
 */
import { Effect, Layer } from "effect";
import type { IndexedDb } from "@effect/platform-browser";
import { Transport } from "@legation/effect";
import { ClientEngine, RpcTransport } from "@legation/effect/internal";
import { BrowserConnectivity, IndexedDbClientStore, ServiceWorkerHost } from "@legation/browser";
import { mutators, registry } from "./domain.js";

export interface HostOptions {
  readonly clientGroupId: string;
  /** e.g. `https://sync.example.com` — defaults to the page's own origin. */
  readonly syncOrigin: string;
  readonly clientId: string;
  readonly indexedDb: Layer.Layer<IndexedDb.IndexedDb>;
}

/**
 * The standard remote transport (WS primary + HTTP fallback —
 * `RpcTransport.fromOrigin`, the same composition `Client.make`'s
 * `transport: { url }` builds), plus browser connectivity awareness.
 */
const transportLayer = (options: HostOptions): Layer.Layer<Transport.ClientTransport> =>
  Layer.effect(Transport.ClientTransport)(
    Effect.gen(function* () {
      const transport = yield* RpcTransport.fromOrigin({
        clientGroupId: options.clientGroupId,
        origin: options.syncOrigin,
      });
      return yield* BrowserConnectivity.withBrowserConnectivity(transport);
    })
  );

/** Serve mirrors + run the sync loop until the scope closes. */
export const runHost = (options: HostOptions): Effect.Effect<never> =>
  ServiceWorkerHost.run({ registry }).pipe(
    Effect.provide(
      ClientEngine.layer({
        clientId: options.clientId,
        clientGroupId: options.clientGroupId,
        mutators,
        syncLoop: { pullInterval: "15 seconds", pushDebounce: "300 millis" },
      }).pipe(
        Layer.provide(transportLayer(options)),
        Layer.provide(IndexedDbClientStore.layer().pipe(Layer.provide(options.indexedDb)))
      )
    ),
    Effect.scoped
  );
