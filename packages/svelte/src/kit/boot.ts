/**
 * Client boot
 *
 * `clientRuntime` is the browser half of the SSR flow: hydrate the page's
 * snapshot into the durable store — but only when the store is empty
 * (`Hydration.hydrateIfEmpty`: a repeat visit's durable rows, cookie, and
 * journalled offline mutations are all fresher than the snapshot) — then build
 * the Client over that store.
 *
 * Both halves are core: `Hydration` does the moving of state, `Client.make`
 * does the wiring. This is only the Svelte-shaped assembly of them, producing
 * the `ManagedRuntime` {@link setClientRuntime} expects, so a root layout can
 * hand it straight to context.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client, ClientStore, Hydration, type Transport } from "@thomasfosterau/legation-effect";
import type { ClientRuntime } from "../Runtime.js";

/** Options for {@link clientRuntime}. */
export interface ClientRuntimeOptions extends Omit<Client.MakeOptions, "store" | "transport"> {
  /** Fully-provided client store layer (e.g. `IndexedDbClientStore.layerWindow()`). */
  readonly store: Layer.Layer<ClientStore.ClientStore>;
  /** Fully-provided transport layer (RPC client, or an in-memory pair in tests). */
  readonly transport: Layer.Layer<Transport.ClientTransport>;
  /** The page's SSR snapshot, hydrated into an empty store before the Client boots. */
  readonly snapshot?: Hydration.Snapshot;
  /** Reads to pin for the runtime's lifetime (the app shell's working set). */
  readonly subscribe?: ReadonlyArray<Parameters<Client.Client["subscribe"]>[0]>;
}

const hydrated = (
  store: Layer.Layer<ClientStore.ClientStore>,
  snapshot: Hydration.Snapshot | undefined
): Layer.Layer<ClientStore.ClientStore> =>
  snapshot === undefined
    ? store
    : Layer.effect(ClientStore.ClientStore)(
        Effect.gen(function* () {
          const built = yield* ClientStore.ClientStore;
          // A hydration failure is a boot-integrity defect, not a recoverable
          // runtime error — surface it as such.
          yield* Hydration.hydrateIfEmpty(built, snapshot).pipe(Effect.orDie);
          return built;
        })
      ).pipe(Layer.provide(store));

/**
 * Build the tab's Client runtime: store (snapshot-hydrated when empty) →
 * transport → `Client.make`, which starts the sync loop itself. Hand the
 * result to `setClientRuntime`, and dispose it when the app tears down.
 */
export const clientRuntime = (options: ClientRuntimeOptions): ClientRuntime => {
  const { store, transport, snapshot, subscribe, ...client } = options;
  return ManagedRuntime.make(
    Layer.effect(Client.Client)(
      Effect.gen(function* () {
        const built = yield* Client.make(client);
        if (subscribe !== undefined) {
          yield* Effect.forEach(subscribe, (read) => built.subscribe(read), {
            discard: true,
          }).pipe(Effect.orDie);
        }
        return built;
      })
    ).pipe(Layer.provide(transport), Layer.provide(hydrated(store, snapshot)))
  );
};
