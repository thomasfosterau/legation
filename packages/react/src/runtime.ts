/**
 * React runtime context
 *
 * The hooks run engine effects through a `ManagedRuntime` that provides the
 * `ClientEngine` — the app builds it (e.g. from `JsonApiSync.layer` or a core
 * composition) and hands it to `EffectSyncProvider`. No JSX: the provider is
 * `React.createElement` so this stays a plain `.ts` module.
 */
import * as React from "react";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import type { ClientEngine } from "@thomasfosterau/effect-sync-core";

/** A runtime that can run `ClientEngine` effects. */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientEngine.ClientEngine, never>;

const RuntimeContext = React.createContext<EffectSyncRuntime | null>(null);

export interface EffectSyncProviderProps {
  readonly runtime: EffectSyncRuntime;
  readonly children?: React.ReactNode;
}

/** Provide the engine runtime to the hooks below. */
export const EffectSyncProvider = (props: EffectSyncProviderProps): React.ReactElement =>
  React.createElement(RuntimeContext.Provider, { value: props.runtime }, props.children);

export const useEffectSyncRuntime = (): EffectSyncRuntime => {
  const runtime = React.useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("useEffectSync* must be used within an <EffectSyncProvider>");
  }
  return runtime;
};
