/**
 * React hooks
 *
 * `useQuery` / `useNamedQuery` bridge a live query (an Effect `Stream` over the
 * mirror) to React via `useSyncExternalStore`: a per-query store runs the
 * engine's `observe` in a forked fiber and pushes each snapshot to subscribers,
 * tearing the fiber down when the last subscriber unmounts. `useMutation`
 * returns a promise-returning mutate function for event handlers.
 */
import * as React from "react";
import { Effect, Fiber, Stream } from "effect";
import { ClientEngine, Subset } from "@thomasfosterau/effect-sync-core";
import { useEffectSyncRuntime, type EffectSyncRuntime } from "./runtime.js";

type Rows = ReadonlyArray<ClientEngine.LocalRow>;
const EMPTY: Rows = [];

interface Store {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Rows;
}

const makeStore = (
  runtime: EffectSyncRuntime,
  toStream: (engine: ClientEngine.ClientEngine) => Stream.Stream<Rows, unknown>
): Store => {
  let snapshot: Rows = EMPTY;
  const listeners = new Set<() => void>();
  let fiber: Fiber.Fiber<void, unknown> | undefined;

  const run = Effect.flatMap(ClientEngine.ClientEngine, (engine) =>
    Stream.runForEach(toStream(engine), (rows) =>
      Effect.sync(() => {
        snapshot = rows;
        for (const listener of listeners) listener();
      })
    )
  ).pipe(Effect.catchCause(() => Effect.void));

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (fiber === undefined) fiber = runtime.runFork(run);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && fiber !== undefined) {
          runtime.runFork(Fiber.interrupt(fiber));
          fiber = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
};

const useStore = (
  toStream: (engine: ClientEngine.ClientEngine) => Stream.Stream<Rows, unknown>,
  deps: ReadonlyArray<unknown>
): Rows => {
  const runtime = useEffectSyncRuntime();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = React.useMemo(() => makeStore(runtime, toStream), [runtime, ...deps]);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};

/** Live result of a subset, re-rendering on every local change. */
export const useQuery = (subset: Subset.Subset): Rows =>
  useStore((engine) => engine.observe(subset), [Subset.hash(subset)]);

/** Live result of a named query (Query.ts). */
export const useNamedQuery = (name: string, args: unknown): Rows =>
  useStore((engine) => engine.observeNamed(name, args), [name, JSON.stringify(args)]);

/** A mutate function for event handlers: returns a promise that resolves once
 * the mutation is journaled optimistically. */
export const useMutation = (): ((mutator: string, args: unknown) => Promise<void>) => {
  const runtime = useEffectSyncRuntime();
  return React.useCallback(
    (mutator, args) =>
      runtime.runPromise(
        Effect.flatMap(ClientEngine.ClientEngine, (engine) => engine.mutate(mutator, args))
      ),
    [runtime]
  );
};
