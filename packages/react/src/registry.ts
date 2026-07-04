/**
 * React registry context
 *
 * The hooks read atoms through an `effect/unstable/reactivity` `AtomRegistry`
 * — the store that holds atom values, subscriptions, and lifetimes. The app
 * builds the engine's reactive surface once with `EngineAtoms.fromLayer` and
 * hands it (and, optionally, a shared registry) to `EffectSyncProvider`. No
 * JSX: the provider is `React.createElement` so this stays a plain `.ts`
 * module.
 */
import * as React from "react";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { ClientEngine, EngineAtoms } from "@legation/effect/internal";

const RegistryContext = React.createContext<AtomRegistry.AtomRegistry | null>(null);
const AtomsContext = React.createContext<EngineAtoms.EngineAtoms | null>(null);

export interface EffectSyncProviderProps {
  /** The engine's reactive surface, from `EngineAtoms.fromLayer(engineLayer)`. */
  readonly atoms: EngineAtoms.EngineAtoms;
  /** A registry to share (e.g. with SSR hydration). One is created if omitted. */
  readonly registry?: AtomRegistry.AtomRegistry;
  readonly children?: React.ReactNode;
}

/** Provide the atom registry and the engine's atoms to the hooks below. */
export const EffectSyncProvider = (props: EffectSyncProviderProps): React.ReactElement => {
  const fallback = React.useState(() => AtomRegistry.make())[0];
  const registry = props.registry ?? fallback;
  return React.createElement(
    RegistryContext.Provider,
    { value: registry },
    React.createElement(AtomsContext.Provider, { value: props.atoms }, props.children)
  );
};

/** The active `AtomRegistry`; throws outside an `EffectSyncProvider`. */
export const useRegistry = (): AtomRegistry.AtomRegistry => {
  const registry = React.useContext(RegistryContext);
  if (registry === null) {
    throw new Error("useEffectSync* must be used within an <EffectSyncProvider>");
  }
  return registry;
};

/** The engine's atoms; throws outside an `EffectSyncProvider`. */
export const useEngineAtoms = (): EngineAtoms.EngineAtoms => {
  const atoms = React.useContext(AtomsContext);
  if (atoms === null) {
    throw new Error("useEffectSync* must be used within an <EffectSyncProvider>");
  }
  return atoms;
};

/**
 * A runtime handle apps use to run engine effects outside components (world
 * setup, demo controls). The React hooks themselves run over the provider's
 * atoms — this alias exists for app plumbing parity with `@legation/svelte`.
 */
export type EffectSyncRuntime = ManagedRuntime.ManagedRuntime<ClientEngine.ClientEngine, never>;
