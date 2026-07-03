/**
 * Svelte runtime context
 *
 * The query stores and the mutate helpers run their effects through a
 * `ManagedRuntime` that provides a {@link ClientView} — the narrow engine
 * surface both hosts satisfy, so the same components work over a main-thread
 * `ClientEngine` and over a service-worker-hosted engine's `TabMirror`
 * (ADR-0021). The app builds the runtime and hands it to the component tree
 * via {@link setEngineRuntime}; the helpers read it back with
 * {@link getEngineRuntime}, so they must be called during component
 * initialisation (the same rule Svelte's `getContext` follows).
 *
 * Engine-backed apps compose `ClientView.layer` over their engine layer
 * (`ClientView.layer.pipe(Layer.provideMerge(engineLayer))`) so the runtime
 * also carries the full `ClientEngine` — which the engine-only helpers
 * (`namedQuery`, auto-subscribing `useRelated`) look up when present.
 */
import { getContext, setContext } from "svelte";
import { Effect, Option, Stream } from "effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import { ClientEngine, type ClientView } from "@legation/effect";

/** A runtime that can run {@link ClientView} effects. */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientView.ClientView, never>;

/**
 * Present an engine-only stream over the view surface: resolved against the
 * runtime's full `ClientEngine` when present, a defect (with an actionable
 * message) when the runtime only holds a mirror.
 *
 * @internal shared by the store and rune modules; not part of the public API.
 */
export const withEngine =
  <T, E>(
    feature: string,
    f: (engine: ClientEngine.ClientEngine) => Stream.Stream<T, E>
  ): ((view: ClientView.ClientView) => Stream.Stream<T, E>) =>
  () =>
    Stream.unwrap(
      Effect.flatMap(
        Effect.serviceOption(ClientEngine.ClientEngine),
        Option.match({
          onNone: () =>
            Effect.die(
              new Error(
                `@legation/svelte: ${feature} requires a full ClientEngine runtime (it is not available over a tab mirror)`
              )
            ),
          onSome: (engine) => Effect.succeed(f(engine)),
        })
      )
    );

const RUNTIME_KEY = Symbol("@legation/svelte/runtime");

/**
 * Provide the engine runtime to descendant components. Call once, high in the
 * tree (typically the root component's `<script>`), before any `query` /
 * `getMutate` call.
 */
export const setEngineRuntime = (runtime: EffectSyncRuntime): void => {
  setContext(RUNTIME_KEY, runtime);
};

/** Read the engine runtime put in context by {@link setEngineRuntime}. */
export const getEngineRuntime = (): EffectSyncRuntime => {
  const runtime = getContext<EffectSyncRuntime | undefined>(RUNTIME_KEY);
  if (runtime === undefined) {
    throw new Error(
      "@legation/svelte: call setEngineRuntime(runtime) higher in the component tree before query()/getMutate()"
    );
  }
  return runtime;
};
