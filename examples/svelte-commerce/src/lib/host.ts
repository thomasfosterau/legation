/**
 * The engine host, host-agnostically: the same composition serves
 * mirrors from the service worker (production — see src/service-worker.ts)
 * and from a dev tab's main thread (Vite's dev service workers can't
 * evaluate module graphs containing dynamic imports, so `+layout.svelte`
 * runs this under a `navigator.locks` leader election instead — ADR-0010's
 * documented degraded mode, and a live demonstration that the host only
 * needs a BroadcastChannel).
 *
 * Paced mutations (#117) — the cart-quantity stepper demo — are wired in
 * *here*, not in the cart page: `Paced.debounce` needs the real
 * `ClientEngine` (`mutateWithAck` + `dropIfPending`), which only exists on
 * this side of the mirror boundary (ADR-0010 — same reason `Undo` isn't
 * usable from a tab in this example either, per `ClientView`'s own doc: "
 * engine-only capabilities... still require the full engine from context").
 * `withPacedCartQty` swaps in a `ClientEngine` whose `mutateWithAck` routes
 * `cart/setQty` through a debounced `PacedMutation` before it ever reaches
 * `EngineHost`, so the cart page keeps calling the ordinary mirror
 * `mutate("cart/setQty", ...)` unchanged — clicking + / − rapidly now
 * collapses to a leading + trailing journal write per cart line instead of
 * one per click.
 */
import { Effect, Layer } from "effect";
import type { IndexedDb } from "@effect/platform-browser";
import { Transport } from "@legation/effect";
import { ClientEngine, Paced, RpcTransport } from "@legation/effect/internal";
import { BrowserConnectivity, IndexedDbClientStore, ServiceWorkerHost } from "@legation/browser";
import { mutators, registry } from "./domain.js";
import type { CartSetQty } from "./domain.js";

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

/**
 * Wrap `mutateWithAck` so `cart/setQty` routes through a debounced
 * `PacedMutation` keyed by cart-line id, leaving every other mutator
 * untouched. `EngineHost.handleMutate` only uses the returned handle's
 * `acknowledged` to forward a later `MutateSettled`; since a paced call's
 * args may be superseded before ever reaching the backend, there is no
 * single authoritative outcome to report for it — `Effect.never` lets that
 * forwarding fiber sit idle (interrupted with the host's scope) rather than
 * fabricate an outcome the backend never produced. The cart page is
 * unaffected: it already fire-and-forgets `mutate("cart/setQty", ...)`
 * without awaiting an outcome.
 */
const withPacedCartQty = (
  engine: ClientEngine.ClientEngine,
  paced: Paced.PacedMutation
): ClientEngine.ClientEngine => ({
  ...engine,
  mutateWithAck: (mutator, args) =>
    mutator === "cart/setQty"
      ? paced
          .call((args as CartSetQty).id, args)
          .pipe(Effect.map(() => ({ mutationId: -1, acknowledged: Effect.never })))
      : engine.mutateWithAck(mutator, args),
});

/** The raw engine layer, wrapped so `cart/setQty` is debounced (#117's demo). */
const pacedEngineLayer = (options: HostOptions): Layer.Layer<ClientEngine.ClientEngine> =>
  Layer.effect(ClientEngine.ClientEngine)(
    Effect.gen(function* () {
      const engine = yield* ClientEngine.ClientEngine;
      const paced = yield* Paced.debounce(engine, "cart/setQty", "300 millis");
      return withPacedCartQty(engine, paced);
    })
  ).pipe(
    Layer.provide(
      ClientEngine.layer({
        clientId: options.clientId,
        clientGroupId: options.clientGroupId,
        mutators,
        syncLoop: { pullInterval: "15 seconds", pushDebounce: "300 millis" },
      }).pipe(
        Layer.provide(transportLayer(options)),
        Layer.provide(IndexedDbClientStore.layer().pipe(Layer.provide(options.indexedDb)))
      )
    )
  );

/** Serve mirrors + run the sync loop until the scope closes. */
export const runHost = (options: HostOptions): Effect.Effect<never> =>
  ServiceWorkerHost.run({ registry }).pipe(
    Effect.provide(pacedEngineLayer(options)),
    Effect.scoped
  );
