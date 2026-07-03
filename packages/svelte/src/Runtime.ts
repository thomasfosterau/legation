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
 * also carries the full `ClientEngine` for engine-only capabilities
 * (explicit push/pull, undo history). Named queries and auto-subscribing
 * `useRelated` need no engine — the view carries them over either host
 * (mirror-protocol extension, ADR-0021).
 */
import { createContext } from "svelte";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type { ClientView } from "@legation/effect";

/** A runtime that can run {@link ClientView} effects. */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientView.ClientView, never>;

// Svelte's type-safe context pair: one instance per module evaluation, so the
// key can't collide with app contexts and the value needs no cast on read.
const [readRuntime, writeRuntime] = createContext<EffectSyncRuntime>();

/**
 * Provide the engine runtime to descendant components. Call once, high in the
 * tree (typically the root component's `<script>`), before any `query` /
 * `getMutate` call.
 */
export const setEngineRuntime = (runtime: EffectSyncRuntime): void => {
  writeRuntime(runtime);
};

/** Read the engine runtime put in context by {@link setEngineRuntime}. */
export const getEngineRuntime = (): EffectSyncRuntime => {
  try {
    return readRuntime();
  } catch {
    // Svelte's context getter throws when no ancestor provided the pair —
    // replace its message with an actionable one.
    throw new Error(
      "@legation/svelte: call setEngineRuntime(runtime) higher in the component tree before query()/getMutate()"
    );
  }
};
