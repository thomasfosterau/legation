/**
 * RpcTransport
 *
 * The default sync transport (ADR-0007): the protocol's push/pull/pokes
 * exposed as a typed `RpcGroup` over `effect/rpc`. The carrier is
 * whichever RPC protocol layer is provided — HTTP, WebSocket, worker, or
 * the in-memory test transport — so the customisable seam (ADR-0008) costs
 * nothing: bind `layerHandlers` to a ServerHandler server-side, provide an
 * `RpcClient.Protocol` client-side, and schema serialization, streaming,
 * and interruption are Effect's RPC machinery.
 */

import { Effect, Layer, Schema, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { TransportError } from "./Errors.js";
import {
  PokeSchema,
  PullRequestSchema,
  PullResponseSchema,
  PushRequestSchema,
  PushResponseSchema,
  ReadRequestSchema,
  ReadResponseSchema,
} from "./Protocol.js";
import { ClientTransport, ServerHandler } from "./Transport.js";
import * as Transport from "./Transport.js";

/** The wire-serializable failure carried on sync RPCs. */
export class SyncRpcError extends Schema.TaggedError<SyncRpcError>()("SyncRpcError", {
  message: Schema.String,
}) {}

/**
 * The sync protocol as a typed RPC group. Apps embedding it next to their
 * own RPCs can namespace it with `SyncRpcs.prefix("sync.")`.
 */
export const SyncRpcs = RpcGroup.make(
  Rpc.make("push", {
    payload: PushRequestSchema,
    success: PushResponseSchema,
    error: SyncRpcError,
  }),
  Rpc.make("pull", {
    payload: PullRequestSchema,
    success: PullResponseSchema,
    error: SyncRpcError,
  }),
  Rpc.make("read", {
    payload: ReadRequestSchema,
    success: ReadResponseSchema,
    error: SyncRpcError,
  }),
  Rpc.make("pokes", {
    payload: { clientGroupId: Schema.String },
    success: PokeSchema,
    stream: true,
  })
);

/** The sync RPCs ({@link SyncRpcs}) as a union of their definitions. */
export type SyncRpc = RpcGroup.Rpcs<typeof SyncRpcs>;

// The RPC carrier's wire error schema carries only a message (SyncRpcError), so
// a typed `VersionNotSupportedError` cannot survive it — it is mapped
// best-effort to a SyncRpcError and reaches the client as a `TransportError`
// (the tag is lost). Carriers that can carry the tag — notably the in-memory
// `ServerHandler`/`ClientTransport` seam — preserve it, so `onUpdateNeeded`
// fires there; over RPC the version rejection degrades to a transport failure
// (#48). Preserving the tag over RPC would mean adding a schema-typed variant to
// this group's error union — deferred.
const toRpcError = (error: { readonly message: string }): SyncRpcError =>
  new SyncRpcError({ message: error.message });

/** Server side: implement the sync RPCs from an in-context ServerHandler. */
export const layerHandlers: Layer.Layer<
  Rpc.ToHandler<SyncRpc>,
  never,
  ServerHandler
> = SyncRpcs.toLayer(
  Effect.gen(function* () {
    const handler = yield* ServerHandler;
    return SyncRpcs.of({
      push: (request) => handler.handlePush(request).pipe(Effect.mapError(toRpcError)),
      pull: (request) => handler.handlePull(request).pipe(Effect.mapError(toRpcError)),
      read: (request) => handler.handleRead(request).pipe(Effect.mapError(toRpcError)),
      pokes: ({ clientGroupId }) => handler.pokes(clientGroupId),
    });
  })
);

const asTransportError = (cause: { readonly message: string }): TransportError =>
  new TransportError({ message: cause.message, cause });

/** Options for the RPC client transport. */
export interface RpcTransportOptions {
  readonly clientGroupId: string;
}

/**
 * Adapt a generated `SyncRpcs` client into a ClientTransport. Connectivity
 * is reported as permanently "connected": RPC protocols reconnect (or fail
 * per call) internally, and sync stays correct over pull alone. Wrap the
 * result with `Transport.withInferredStatus` for behaviour-derived status
 * (and `Transport.withFallback` to degrade to a second carrier); in browsers
 * add `BrowserConnectivity.withBrowserConnectivity` on top.
 */
export const fromRpcClient = <E extends { readonly message: string }>(
  client: RpcClient.RpcClient<SyncRpc, E>,
  options: RpcTransportOptions
): ClientTransport => ({
  push: (request) => client.push(request).pipe(Effect.mapError(asTransportError)),
  pull: (request) => client.pull(request).pipe(Effect.mapError(asTransportError)),
  read: (request) => client.read(request).pipe(Effect.mapError(asTransportError)),
  pokes: client
    .pokes({ clientGroupId: options.clientGroupId })
    .pipe(Stream.mapError(asTransportError)),
  status: Effect.succeed("connected"),
  statusChanges: Stream.succeed("connected"),
});

/** Build a ClientTransport over a real RPC protocol (HTTP, WebSocket, …). */
export const make = (
  options: RpcTransportOptions
): Effect.Effect<ClientTransport, never, RpcClient.Protocol | Scope.Scope> =>
  RpcClient.make(SyncRpcs).pipe(Effect.map((client) => fromRpcClient(client, options)));

/** Layer building the ClientTransport from an in-context RPC protocol. */
export const layer = (
  options: RpcTransportOptions
): Layer.Layer<ClientTransport, never, RpcClient.Protocol> =>
  Layer.effect(ClientTransport)(make(options));

// ─── The standard remote composition ─────────────────────────────────────────

/** Options for {@link fromOrigin}. */
export interface FromOriginOptions {
  readonly clientGroupId: string;
  /** The sync server's origin, e.g. `https://sync.example.com`. */
  readonly origin: string;
  /** The HTTP POST route (the fallback carrier). Default `/sync`. */
  readonly httpPath?: string;
  /** The WebSocket route (the live carrier). Default `/sync-ws`. */
  readonly wsPath?: string;
  /**
   * Fallback tuning ({@link Transport.withFallback}). Defaults: sidelined
   * primaries retry after 30 seconds; each WebSocket call gets a 10-second
   * budget before the call falls to HTTP.
   */
  readonly fallback?: Transport.FallbackOptions;
}

/**
 * The standard remote transport: sync RPCs over a WebSocket (the live
 * path, pokes included) with plain HTTP POST as the fallback carrier —
 * `Client.make`'s `transport: { url }` shorthand builds exactly this.
 * Wrap with `BrowserConnectivity.withBrowserConnectivity`
 * (`@thomasfosterau/legation-browser`) for navigator-aware status in browsers.
 */
export const fromOrigin = (
  options: FromOriginOptions
): Effect.Effect<ClientTransport, never, Scope.Scope> =>
  Effect.gen(function* () {
    const httpUrl = `${options.origin}${options.httpPath ?? "/sync"}`;
    const wsUrl = `${options.origin.replace(/^http/, "ws")}${options.wsPath ?? "/sync-ws"}`;
    // Layer.build ties each protocol's resources to the enclosing scope
    // (Effect.provide here would finalize them on return).
    const wsContext = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(wsUrl)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerNdjson)
      )
    );
    const ws = yield* make({ clientGroupId: options.clientGroupId }).pipe(
      Effect.provide(wsContext)
    );
    const httpContext = yield* Layer.build(
      RpcClient.layerProtocolHttp({ url: httpUrl }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(FetchHttpClient.layer)
      )
    );
    const http = yield* make({ clientGroupId: options.clientGroupId }).pipe(
      Effect.provide(httpContext)
    );
    // primaryTimeout: a hanging WebSocket must not stall sync — time it
    // out, sideline it, serve through HTTP.
    return yield* Transport.withFallback(ws, http, {
      restoreAfter: options.fallback?.restoreAfter ?? "30 seconds",
      primaryTimeout: options.fallback?.primaryTimeout ?? "10 seconds",
    });
  });
