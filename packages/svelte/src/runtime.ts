/**
 * Svelte runtime context
 *
 * The query stores and the mutate helper run engine effects through a
 * `ManagedRuntime` that provides the `ClientEngine` — the app builds it (e.g.
 * from a core composition or `JsonApiSync.layer`) and hands it to the component
 * tree via {@link setEngineRuntime}. `query`/`namedQuery`/`getMutate` read it
 * back with {@link getEngineRuntime}, so they must be called during component
 * initialisation (the same rule Svelte's `getContext` follows).
 */
import { getContext, setContext } from "svelte";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type { ClientEngine } from "@legation/effect";

/** A runtime that can run `ClientEngine` effects. */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientEngine.ClientEngine, never>;

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
