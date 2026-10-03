/**
 * The engine host, host-agnostically: the same composition serves mirrors
 * from the service worker (production — see src/service-worker.ts). It only
 * needs a `BroadcastChannel`, so the identical composition also works
 * un-elected on a main thread — that's `@thomasfosterau/legation-browser`'s `ElectedHost`
 * (the shipped no-service-worker fallback, ADR-0010), which wraps this same
 * `ServiceWorkerHost.run` call behind a `navigator.locks` leader election
 * (#119). This app runs the service worker by default (dev included), but
 * `bootElected` below wires the same domain (nodes/mutators/transport) onto
 * `ElectedHost.run` instead — a documented dev-mode toggle (`?host=main` in
 * `+layout.svelte`) so the no-service-worker fallback topology actually gets
 * exercised somewhere, not just unit-tested (#133 item 6).
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
 * one per click. `bootElected` does not wire this in — it demonstrates the
 * plain topology, and a paced elected host is unexercised follow-up.
 *
 * The worker also serves the JSON:API façade (ADR-0029, #166) beside the
 * mirrors: `runHost` starts the host through `ServiceWorkerHost.start` and
 * hands `onStart` what the façade reads — the engine, the registrations the
 * host holds on the tabs' behalf (the only ledger in the worker that knows
 * what the mirrors pinned), and the store's cookie — so
 * `src/service-worker.ts` can build it from `lib/facade.ts`. The host is
 * given `nodes` and `urls` too, so a page with no `Client` can pin a URL
 * (`SubscribeUrl`) and have the façade serve it.
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { IndexedDb } from "@effect/platform-browser";
import { Client, ClientStore, type StoreError, Transport } from "@thomasfosterau/legation-effect";
import { ClientEngine, Paced, RpcTransport } from "@thomasfosterau/legation-effect/internal";
import {
  BrowserConnectivity,
  ElectedHost,
  IndexedDbClientStore,
  ServiceWorkerHost,
} from "@thomasfosterau/legation-browser";
import { JsonApiQuery } from "@thomasfosterau/legation-jsonapi";
import { mutators, nodes, registry, shellReads } from "./domain.js";
import type { CartSetQty } from "./domain.js";

/** The serving host, as the worker's façade needs it. */
export interface StartedHost extends ServiceWorkerHost.Host {
  /** The replica's CVR cookie, for `x-legation-served-at`. */
  readonly cookie: Effect.Effect<string | undefined, StoreError>;
}

export interface HostOptions {
  readonly clientGroupId: string;
  /** e.g. `https://sync.example.com` — defaults to the page's own origin. */
  readonly syncOrigin: string;
  readonly clientId: string;
  readonly indexedDb: Layer.Layer<IndexedDb.IndexedDb>;
  /** Called once the host serves: the worker installs the façade here. */
  readonly onStart?: (host: StartedHost) => void;
}

/**
 * The standard remote transport (WS primary + HTTP fallback —
 * `RpcTransport.fromOrigin`, the same composition `Client.make`'s
 * `transport: { url }` builds), plus browser connectivity awareness.
 */
const transportLayer = (options: {
  readonly clientGroupId: string;
  readonly syncOrigin: string;
}): Layer.Layer<Transport.ClientTransport> =>
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

/** The raw engine layer over the store in context, wrapped so `cart/setQty` is debounced (#117's demo). */
const pacedEngineLayer = (
  options: HostOptions
): Layer.Layer<ClientEngine.ClientEngine, never, ClientStore.ClientStore> =>
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
      }).pipe(Layer.provide(transportLayer(options)))
    )
  );

/** The durable store, kept in context beside the engine: the façade reads its cookie. */
const storeLayer = (options: HostOptions): Layer.Layer<ClientStore.ClientStore> =>
  IndexedDbClientStore.layer().pipe(Layer.provide(options.indexedDb));

/** Serve mirrors + run the sync loop until the scope closes, telling `onStart` what the façade needs. */
export const runHost = (options: HostOptions): Effect.Effect<never> =>
  Effect.gen(function* () {
    const host = yield* ServiceWorkerHost.start({
      registry,
      nodes,
      urls: JsonApiQuery.urlReads(nodes),
    });
    const store = yield* ClientStore.ClientStore;
    options.onStart?.({ ...host, cookie: store.getCookie });
    return yield* Effect.never;
  }).pipe(
    Effect.provide(pacedEngineLayer(options).pipe(Layer.provideMerge(storeLayer(options)))),
    Effect.scoped
  );

export interface ElectedBootOptions {
  readonly clientGroupId: string;
  readonly syncOrigin: string;
  readonly userId: string | undefined;
}

/**
 * Dev-mode toggle (#133 item 6, `?host=main` in `+layout.svelte`): the same
 * domain (nodes/mutators) and transport `runHost` gives the service worker,
 * hosted via `ElectedHost.run`'s `navigator.locks` leader election instead —
 * the shipped no-service-worker fallback (ADR-0010, #119) — so it actually
 * runs somewhere in this repo, not just under `elected-host.test.ts`. One
 * `ManagedRuntime` per tab, holding the SAME `IndexedDbClientStore` a service
 * worker would (same-origin `window`/worker `indexedDB` share storage), so
 * switching the toggle mid-session resumes the same journal/rows/cookie.
 * `role` is purely observational (a debug badge) — resolved once
 * `ElectedHost.run`'s election settles, never read by application logic.
 */
export const bootElected = (
  options: ElectedBootOptions
): {
  readonly runtime: ManagedRuntime.ManagedRuntime<Client.Client, never>;
  readonly role: Stream.Stream<ElectedHost.Role>;
} => {
  let resolveRole: (role: Stream.Stream<ElectedHost.Role>) => void = () => {};
  const rolePromise = new Promise<Stream.Stream<ElectedHost.Role>>((resolve) => {
    resolveRole = resolve;
  });
  const runtime = ManagedRuntime.make(
    Layer.effect(Client.Client)(
      Effect.gen(function* () {
        const elected = yield* ElectedHost.run({
          clientGroupId: options.clientGroupId,
          nodes,
          mutations: mutators,
          registry,
          dependencies: Layer.merge(transportLayer(options), IndexedDbClientStore.layerWindow()),
        });
        resolveRole(elected.role);
        yield* Effect.forEach(
          shellReads(options.userId),
          (read) => elected.client.subscribe(read),
          { discard: true }
        ).pipe(Effect.orDie);
        return elected.client;
      })
    )
  );
  // Touch the runtime so the election (and the shell subscriptions) start now.
  void runtime.runPromise(Effect.asVoid(Client.Client)).catch(() => undefined);
  return { runtime, role: Stream.unwrap(Effect.promise(() => rolePromise)) };
};
