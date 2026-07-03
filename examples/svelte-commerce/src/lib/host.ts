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
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import type { IndexedDb } from "@effect/platform-browser";
import { ClientEngine, RpcTransport, Transport } from "@legation/effect";
import { BrowserConnectivity, IndexedDbClientStore, ServiceWorkerHost } from "@legation/browser";
import { mutators, registry } from "./domain.js";

export interface HostOptions {
  readonly clientGroupId: string;
  /** e.g. `https://sync.example.com` — defaults to the page's own origin. */
  readonly syncOrigin: string;
  readonly clientId: string;
  readonly indexedDb: Layer.Layer<IndexedDb.IndexedDb>;
}

/** WS primary + HTTP fallback + connectivity, as one transport layer. */
const transportLayer = (options: HostOptions): Layer.Layer<Transport.ClientTransport> =>
  Layer.effect(Transport.ClientTransport)(
    Effect.gen(function* () {
      const httpUrl = `${options.syncOrigin}/sync`;
      const wsUrl = `${options.syncOrigin.replace(/^http/, "ws")}/sync-ws`;
      // Layer.build ties each protocol's resources to the enclosing layer
      // scope (Effect.provide here would finalize them on return).
      const wsContext = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(wsUrl)),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerNdjson)
        )
      );
      const ws = yield* RpcTransport.make({ clientGroupId: options.clientGroupId }).pipe(
        Effect.provide(wsContext)
      );
      const httpContext = yield* Layer.build(
        RpcClient.layerProtocolHttp({ url: httpUrl }).pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(FetchHttpClient.layer)
        )
      );
      const http = yield* RpcTransport.make({ clientGroupId: options.clientGroupId }).pipe(
        Effect.provide(httpContext)
      );
      // primaryTimeout: a hanging WebSocket must not stall sync — time it
      // out, sideline it, serve through HTTP.
      const combined = yield* Transport.withFallback(ws, http, {
        restoreAfter: "30 seconds",
        primaryTimeout: "10 seconds",
      });
      return yield* BrowserConnectivity.withBrowserConnectivity(combined);
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
