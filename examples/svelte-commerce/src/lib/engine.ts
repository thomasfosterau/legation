/**
 * Client engine boot — the browser side of the sync topology.
 *
 * Transport: WebSockets to the sync server (`/sync-ws`) as the live path,
 * degrading per call to plain HTTP POST (`/sync`) via
 * `Transport.withFallback`, with `BrowserConnectivity` folding in
 * `navigator.onLine` and return-to-visible pokes. Pull stays the correctness
 * path throughout (ADR-0008) — killing WebSockets only loses latency.
 *
 * Store: IndexedDB, so the journal and confirmed rows survive reloads; the
 * SSR snapshot hydrates only an empty store (`engineRuntime` from
 * `@legation/sveltekit`). The runtime exposes both the `ClientView` (what the
 * bindings consume) and the full engine (undo, explicit push/pull, named
 * queries).
 */
import { Effect, Layer } from "effect";
import { ClientEngine, Hydration, RpcTransport, Transport } from "@legation/effect";
import { BrowserConnectivity, IndexedDbClientStore } from "@legation/browser";
import { engineRuntime } from "@legation/sveltekit";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { mutators, shellSubsets } from "./domain.js";

const SYNC_HTTP = "/sync";
const SYNC_WS = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync-ws`;

/** WS primary + HTTP fallback + browser connectivity, as one transport layer. */
const transportLayer = (clientGroupId: string): Layer.Layer<Transport.ClientTransport> =>
  Layer.effect(Transport.ClientTransport)(
    Effect.gen(function* () {
      const options = { clientGroupId };
      // Layer.build ties each protocol's resources (sockets, queues) to the
      // enclosing layer scope — `Effect.provide` here would finalize them the
      // moment this constructor returns, leaving a transport whose every
      // call hangs on torn-down machinery.
      const wsContext = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(SYNC_WS())),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerNdjson)
        )
      );
      const ws = yield* RpcTransport.make(options).pipe(Effect.provide(wsContext));
      const httpContext = yield* Layer.build(
        RpcClient.layerProtocolHttp({ url: SYNC_HTTP }).pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(FetchHttpClient.layer)
        )
      );
      const http = yield* RpcTransport.make(options).pipe(Effect.provide(httpContext));
      // primaryTimeout: a WebSocket that hangs (rather than fails) must not
      // stall sync — time it out, sideline it, and serve through HTTP.
      const combined = yield* Transport.withFallback(ws, http, {
        restoreAfter: "30 seconds",
        primaryTimeout: "10 seconds",
      });
      return yield* BrowserConnectivity.withBrowserConnectivity(combined);
    })
  );

export interface BootData {
  readonly snapshot: Hydration.Snapshot;
  readonly clientGroupId: string;
  readonly userId: string | undefined;
}

/** The app runtime: the bindings' ClientView plus the full engine. */
export type AppRuntime = ReturnType<typeof engineRuntime>;

/** Build the app's engine runtime once (call from the root layout). */
export const boot = (data: BootData): AppRuntime =>
  engineRuntime({
    engine: {
      clientId: `tab-${Math.random().toString(36).slice(2, 10)}`,
      clientGroupId: data.clientGroupId,
      mutators,
      syncLoop: { pullInterval: "15 seconds", pushDebounce: "300 millis" },
    },
    store: IndexedDbClientStore.layerWindow(),
    transport: transportLayer(data.clientGroupId),
    snapshot: data.snapshot,
  });

/**
 * SSR stub runtime: the rune hooks read the runtime from context at init but
 * only *use* it inside `$effect`, which never runs on the server — SSR
 * renders come entirely from the hooks' `initial` seeds. Any server-side
 * invocation is therefore a bug, and this stub makes it loud. (A candidate
 * `@legation/sveltekit` helper.)
 */
export const ssrStub = (): AppRuntime =>
  new Proxy({} as AppRuntime, {
    get(_target, property) {
      throw new Error(
        `engine runtime accessed during SSR (.${String(property)}) — render from initial seeds instead`
      );
    },
  });

/** Run the sync loop for the app's lifetime (call once, client-side). */
export const startSync = (runtime: AppRuntime, userId: string | undefined): void => {
  // runSync forks its loops into the surrounding scope and returns — hold the
  // scope open for the page's lifetime (closing it would kill every fiber).
  void runtime.runPromise(
    Effect.scoped(
      Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
        Effect.gen(function* () {
          // Subscriptions are client state (the snapshot carries rows + the
          // CVR cookie, not the subscription set): register the shell's
          // subsets before the first pull, or that pull unsyncs everything.
          for (const subset of shellSubsets(userId)) {
            yield* engine.subscribe(subset);
          }
          yield* engine.runSync;
          yield* Effect.never;
        })
      )
    ).pipe(Effect.catchCause(() => Effect.void))
  );
};
