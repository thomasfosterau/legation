/**
 * Svelte runtime context
 *
 * The query stores and the mutate helpers run their effects through a
 * `ManagedRuntime` that provides a {@link ClientView} — the narrow engine
 * surface both hosts satisfy, so the same components work over a main-thread
 * `ClientEngine` and over a service-worker-hosted engine's `Mirror`
 * (ADR-0021). The app builds the runtime and hands it to the component tree
 * via {@link setEngineRuntime}; the helpers read it back with
 * {@link getEngineRuntime}, so they must be called during component
 * initialisation (the same rule Svelte's `getContext` follows).
 *
 * Engine-backed apps compose `ClientView.layer` over their engine layer
 * (`ClientView.layer.pipe(Layer.provideMerge(engineLayer))`) so the runtime
 * also carries the full `ClientEngine` for engine-only capabilities
 * (explicit push/pull, undo history). Named queries and auto-subscribing
 * `useRelated` need no engine — the view carries them over either host
 * (mirror-protocol extension, ADR-0021).
 */
import { createRuntimeContext } from "@thomasfosterau/effect-svelte";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type { ClientView } from "@legation/effect";

/** A runtime that can run {@link ClientView} effects. */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientView.ClientView, never>;

// The typed runtime context is effect-svelte's `createRuntimeContext`: one
// context instance per call, so the engine context can't collide with the
// default untyped context or with other libraries'.
const context = createRuntimeContext<ClientView.ClientView>(
  "@legation/svelte — call setEngineRuntime(runtime) higher in the component tree"
);

/**
 * Provide the engine runtime to descendant components. Call once, high in the
 * tree (typically the root component's `<script>`), before any `query` /
 * `getMutate` call.
 */
export const setEngineRuntime = (runtime: EffectSyncRuntime): void => {
  context.provide(runtime);
};

/** Read the engine runtime put in context by {@link setEngineRuntime}. */
export const getEngineRuntime = (): EffectSyncRuntime =>
  // The upstream context carries `RuntimeLike` (a Context | ManagedRuntime
  // union); `setEngineRuntime` is its only writer and takes the managed
  // runtime, so the read narrows back to what was provided.
  context.get() as EffectSyncRuntime;
