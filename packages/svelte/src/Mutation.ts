/**
 * Mutate helpers
 *
 * `getMutate` returns a promise-returning `mutate(name, args)` for event
 * handlers: it runs the view's optimistic `mutate` on the context runtime and
 * resolves once the mutation is journaled (and rendered through the overlay).
 * Both helpers run over the runtime's {@link ClientView}, so they work over a
 * main-thread engine and a tab mirror equally (ADR-0021).
 */
import { Effect } from "effect";
import { ClientEngine, ClientView } from "@legation/effect";
import { getEngineRuntime } from "./Runtime.js";

/** A `mutate(mutator, args)` bound to the context runtime. */
export const getMutate = (): ((mutator: string, args: unknown) => Promise<void>) => {
  const runtime = getEngineRuntime();
  return (mutator, args) =>
    runtime.runPromise(Effect.flatMap(ClientView.ClientView, (view) => view.mutate(mutator, args)));
};

/**
 * Like {@link getMutate}, but the promise resolves with the mutation's
 * authoritative outcome (applied or permanently rejected) once the backend
 * settles it, rather than on journal.
 */
export const getMutateWithAck = (): ((
  mutator: string,
  args: unknown
) => Promise<ClientEngine.MutationOutcome>) => {
  const runtime = getEngineRuntime();
  return (mutator, args) =>
    runtime.runPromise(
      Effect.flatMap(ClientView.ClientView, (view) => view.mutateWithAck(mutator, args))
    );
};
