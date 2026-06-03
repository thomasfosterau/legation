/**
 * PromiseFacade
 *
 * Helpers for driving the Effect-native sync engine from non-Effect code:
 * plain promises and callback subscriptions. This is what framework
 * bindings (React hooks, Vue composables, vanilla JS apps, service worker
 * scripts) build on.
 *
 * A facade wraps a `ManagedRuntime` built from the layer that provides
 * the engine's services. Effects are run with `run`/`runExit`, streams are
 * consumed with `subscribe`, and `dispose` tears everything down.
 */

import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Result, Stream } from "effect";

/**
 * A callback subscription handle.
 */
export interface Subscription {
  /** Stop receiving values and release the underlying fiber. */
  readonly unsubscribe: () => void;
}

/**
 * A promise/callback facade over an Effect runtime.
 */
export interface PromiseFacade<R> {
  /** The underlying managed runtime (for advanced use). */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /** Run an effect, rejecting the promise on any failure. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  /** Run an effect, resolving with its `Exit` (never rejects on typed failures). */
  readonly runExit: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>>;
  /** Consume a stream with callbacks. */
  readonly subscribe: <A, E>(
    stream: Stream.Stream<A, E, R>,
    listener: {
      readonly onValue: (value: A) => void;
      readonly onError?: ((error: E) => void) | undefined;
      readonly onDone?: (() => void) | undefined;
    }
  ) => Subscription;
  /** Tear down the runtime and every running subscription. */
  readonly dispose: () => Promise<void>;
}

/**
 * Build a promise/callback facade from a layer providing `R`.
 *
 * ```ts
 * const facade = makePromiseFacade(
 *   SyncCache.layer.pipe(Layer.provideMerge(MemoryCacheStore.layer()))
 * );
 * const value = await facade.run(
 *   Effect.flatMap(SyncCache.SyncCache.asEffect(), (cache) =>
 *     cache.read({ key: ["users", "1"], loader: fetchUser("1") })
 *   )
 * );
 * await facade.dispose();
 * ```
 */
export const make = <R, ER>(layer: Layer.Layer<R, ER, never>): PromiseFacade<R> => {
  // The error channel of the layer is surfaced when effects run, so the
  // facade itself treats the runtime as infallible for ergonomic typing.
  const runtime = ManagedRuntime.make(layer) as unknown as ManagedRuntime.ManagedRuntime<R, never>;

  const run = <A, E>(effect: Effect.Effect<A, E, R>): Promise<A> => runtime.runPromise(effect);

  const runExit = <A, E>(effect: Effect.Effect<A, E, R>): Promise<Exit.Exit<A, E>> =>
    runtime.runPromiseExit(effect);

  const subscribe = <A, E>(
    stream: Stream.Stream<A, E, R>,
    listener: {
      readonly onValue: (value: A) => void;
      readonly onError?: ((error: E) => void) | undefined;
      readonly onDone?: (() => void) | undefined;
    }
  ): Subscription => {
    const consume = Stream.runForEach(stream, (value) =>
      Effect.sync(() => listener.onValue(value))
    );

    const fiber = runtime.runFork(
      consume.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              listener.onDone?.();
            } else if (Exit.isFailure(exit) && listener.onError !== undefined) {
              // Surface the first typed failure, if any.
              const failure = Cause.findFail(exit.cause);
              if (Result.isSuccess(failure)) {
                listener.onError(failure.success.error);
              }
            }
          })
        )
      )
    );

    return {
      unsubscribe: () => {
        runtime.runFork(Fiber.interrupt(fiber));
      },
    };
  };

  return {
    runtime,
    run,
    runExit,
    subscribe,
    dispose: () => runtime.dispose(),
  };
};
