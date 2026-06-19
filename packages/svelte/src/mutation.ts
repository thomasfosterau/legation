/**
 * Mutate helper
 *
 * `getMutate` returns a promise-returning `mutate(name, args)` for event
 * handlers: it runs the engine's optimistic `mutate` on the context runtime and
 * resolves once the mutation is journaled (and rendered through the overlay).
 */
import { Effect } from "effect";
import { ClientEngine } from "@thomasfosterau/effect-sync-core";
import { getEngineRuntime } from "./runtime.js";

/** A `mutate(mutator, args)` bound to the context runtime. */
export const getMutate = (): ((mutator: string, args: unknown) => Promise<void>) => {
  const runtime = getEngineRuntime();
  return (mutator, args) =>
    runtime.runPromise(
      Effect.flatMap(ClientEngine.ClientEngine, (engine) => engine.mutate(mutator, args))
    );
};
