/**
 * Client boot
 *
 * `engineRuntime` composes the client-side engine for a SvelteKit app: a
 * durable store layer (IndexedDB in the browser, memory in tests), a
 * transport layer, and the engine options — hydrating the page's SSR
 * snapshot into the store first, but only when the store is empty
 * (`Hydration.hydrateIfEmpty`: a repeat visit's durable rows, cookie, and
 * journalled offline mutations are all fresher than the snapshot). The
 * result is the `ManagedRuntime` that `@legation/svelte`'s
 * `setEngineRuntime` expects.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { ClientStore, type Transport } from "@legation/effect";
import { ClientEngine, ClientView, Hydration } from "@legation/effect/internal";

/** Options for {@link engineRuntime}. */
export interface EngineRuntimeOptions {
  /** Engine options: clientId, clientGroupId (the cookie's value), mutators, queries, sync loop. */
  readonly engine: ClientEngine.ClientEngineOptions;
  /** Fully-provided client store layer (e.g. `IndexedDbClientStore.layerWindow()`). */
  readonly store: Layer.Layer<ClientStore.ClientStore>;
  /** Fully-provided transport layer (RPC client, or an in-memory pair in tests). */
  readonly transport: Layer.Layer<Transport.ClientTransport>;
  /** The page's SSR snapshot, hydrated into an empty store before the engine boots. */
  readonly snapshot?: Hydration.Snapshot;
}

const hydratedStore = (
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
 * Build the engine runtime for the browser: store (snapshot-hydrated when
 * empty) → transport → engine, with the narrow {@link ClientView} derived on
 * top (what the bindings consume) alongside the full engine (what engine-only
 * helpers look up). Hand the result to `setEngineRuntime` from
 * `@legation/svelte`, and dispose it when the app tears down.
 */
export const engineRuntime = (
  options: EngineRuntimeOptions
): ManagedRuntime.ManagedRuntime<ClientView.ClientView | ClientEngine.ClientEngine, never> =>
  ManagedRuntime.make(
    ClientView.layer.pipe(
      Layer.provideMerge(
        ClientEngine.layer(options.engine).pipe(
          Layer.provide(options.transport),
          Layer.provide(hydratedStore(options.store, options.snapshot))
        )
      )
    )
  );
