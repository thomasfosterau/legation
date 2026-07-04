/**
 * HttpSyncServer
 *
 * Node bindings for the default RPC sync transport (ADR-0007): register
 * the sync RPCs on an HttpRouter — over the plain HTTP POST protocol or
 * WebSockets — and serve them with Node's HTTP server. The seam stays
 * layered: provide a ServerHandler (e.g. `SyncRoom.layer` over your
 * Backend) below, pick a carrier here, and serve.
 *
 * NDJSON serialization is the default: it frames equally well for unary
 * calls and streamed pokes.
 */

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Transport } from "@legation/effect";
import { RpcTransport } from "@legation/effect/internal";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

export interface HttpSyncServerOptions {
  /** Route the sync RPCs are served on, e.g. `"/sync"`. */
  readonly path: HttpRouter.PathInput;
  /** Wire framing. Defaults to NDJSON. */
  readonly serialization?: Layer.Layer<RpcSerialization.RpcSerialization>;
}

const make = (
  options: HttpSyncServerOptions,
  protocol: Layer.Layer<
    RpcServer.Protocol,
    never,
    RpcSerialization.RpcSerialization | HttpRouter.HttpRouter
  >
): Layer.Layer<never, never, Transport.ServerHandler | HttpRouter.HttpRouter> =>
  RpcServer.layer(RpcTransport.SyncRpcs).pipe(
    Layer.provide(RpcTransport.layerHandlers),
    Layer.provide(protocol),
    Layer.provide(options.serialization ?? RpcSerialization.layerNdjson)
  );

/** Register the sync RPCs at `path` over the HTTP POST protocol. */
export const layerHttp = (
  options: HttpSyncServerOptions
): Layer.Layer<never, never, Transport.ServerHandler | HttpRouter.HttpRouter> =>
  make(options, RpcServer.layerProtocolHttp({ path: options.path }));

/** Register the sync RPCs at `path` over the WebSocket protocol. */
export const layerWebSocket = (
  options: HttpSyncServerOptions
): Layer.Layer<never, never, Transport.ServerHandler | HttpRouter.HttpRouter> =>
  make(options, RpcServer.layerProtocolWebsocket({ path: options.path }));

export interface ListenOptions extends HttpSyncServerOptions {
  readonly port: number;
  readonly host?: string;
}

/**
 * Serve the sync RPCs on a Node HTTP server: `layerHttp` + router + Node
 * listener in one layer. Provide a ServerHandler below it.
 */
export const layerServe = (
  options: ListenOptions
): Layer.Layer<never, ServeError, Transport.ServerHandler> =>
  HttpRouter.serve(layerHttp(options)).pipe(
    Layer.provide(
      NodeHttpServer.layer(
        createServer,
        options.host === undefined
          ? { port: options.port }
          : { port: options.port, host: options.host }
      )
    )
  );
