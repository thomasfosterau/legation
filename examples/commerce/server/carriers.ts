/**
 * The sync carriers: the default RPC sync transport (ADR-0007) registered on
 * the app's `HttpRouter`, over WebSockets and over plain HTTP POST.
 *
 * This is the whole of what a carrier is: the engine's sync RPCs
 * (`RpcTransport.SyncRpcs`) and their handlers, served by `effect/rpc` on a
 * protocol, NDJSON-framed. Nothing here is Node-specific; the router is served
 * by `NodeHttpServer` in `main.ts` (and by the test harness).
 */
import * as Layer from "effect/Layer";
import type { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import type { Transport } from "@thomasfosterau/legation";
import { RpcTransport } from "@thomasfosterau/legation/internal";

const carrier = (
  protocol: Layer.Layer<
    RpcServer.Protocol,
    never,
    RpcSerialization.RpcSerialization | HttpRouter.HttpRouter
  >
): Layer.Layer<never, never, Transport.ServerHandler | HttpRouter.HttpRouter> =>
  RpcServer.layer(RpcTransport.SyncRpcs).pipe(
    Layer.provide(RpcTransport.layerHandlers),
    Layer.provide(protocol),
    Layer.provide(RpcSerialization.layerNdjson)
  );

/** WebSockets at `/sync-ws` (the live path) and HTTP POST at `/sync` (the fallback). */
export const carriers = Layer.mergeAll(
  carrier(RpcServer.layerProtocolWebsocket({ path: "/sync-ws" })),
  carrier(RpcServer.layerProtocolHttp({ path: "/sync" }))
);
