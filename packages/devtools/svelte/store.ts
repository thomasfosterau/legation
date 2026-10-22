/**
 * @thomasfosterau/legation-devtools/svelte — store adapters
 *
 * Bridges the headless {@link Devtools.DevtoolsCore} (#120) to Svelte
 * `Readable` stores, the same shape `@thomasfosterau/legation-svelte`'s own `Query.ts`
 * bridges live queries with: a store's `start` callback forks the source in
 * a fiber and pushes each value through `set`; `stop` interrupts that fiber
 * when the last subscriber unsubscribes. No data acquisition of its own —
 * every store here just runs one of the core's Effects/Streams.
 *
 * Shipped as raw source (not pre-compiled): this subpath is consumed
 * directly by a Svelte-aware bundler (any Svelte 5 app already has one), the
 * same as the `.svelte` panel component alongside it.
 */
import { readable, type Readable } from "svelte/store";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HashMap from "effect/HashMap";
import * as Stream from "effect/Stream";
import type { ClientEngine, MutationState, Subset } from "@thomasfosterau/legation-effect/internal";
import type * as Devtools from "@thomasfosterau/legation-devtools";

/** Subscribe to a `Stream` as a store; `initial` until the first emission. */
export const toStreamStore = <A>(stream: Stream.Stream<A>, initial: A): Readable<A> =>
  readable<A>(initial, (set) => {
    const fiber = Effect.runFork(Stream.runForEach(stream, (a) => Effect.sync(() => set(a))));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

/**
 * Re-run a one-shot Effect snapshot whenever `signal` (a live Stream) emits,
 * plus once on subscribe — see `react.tsx`'s `useSnapshot` for the same
 * pattern and its rationale (the Introspection substrate's plain-Effect
 * reads aren't Streams; `events` is the "something changed" trigger).
 */
export const toSnapshotStore = <A, E, S>(
  effect: Effect.Effect<A, E>,
  signal: Stream.Stream<S>,
  initial: A
): Readable<A> =>
  readable<A>(initial, (set) => {
    const safe = Effect.catch(effect, () => Effect.succeed(initial));
    const refresh = Effect.runFork(Effect.map(safe, (a) => set(a)));
    const fiber = Effect.runFork(Stream.runForEach(signal, () => Effect.map(safe, (a) => set(a))));
    return () => {
      Effect.runFork(Fiber.interrupt(refresh));
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

/** A capped rolling log of a Stream's emissions, newest last. */
export const toLogStore = <A>(
  stream: Stream.Stream<A>,
  limit: number
): Readable<ReadonlyArray<A>> =>
  readable<ReadonlyArray<A>>([], (set) => {
    let log: ReadonlyArray<A> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(stream, (a) =>
        Effect.sync(() => {
          log = [...log, a].slice(-limit);
          set(log);
        })
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

const EMPTY_STATES: MutationState.MutationStateMap = HashMap.empty();

/** Devtools stores for one core instance — the panel's whole data surface. */
export interface DevtoolsStores {
  readonly mutationStates: Readable<MutationState.MutationStateMap>;
  readonly subscriptions: Readable<ReadonlyArray<Subset.Subset>>;
  readonly cookie: Readable<string | undefined>;
  readonly collections: Readable<ReadonlyArray<Devtools.CollectionSummary>>;
  readonly events: Readable<ReadonlyArray<ClientEngine.EngineEvent>>;
  readonly syncFailures: Readable<ReadonlyArray<ClientEngine.SyncFailure>>;
}

/** Build every store the panel needs from one {@link Devtools.DevtoolsCore}. */
export const makeStores = (core: Devtools.DevtoolsCore): DevtoolsStores => ({
  mutationStates: toStreamStore(core.mutationStates, EMPTY_STATES),
  subscriptions: toSnapshotStore(core.subscriptions, core.events, []),
  cookie: toSnapshotStore(core.cookie, core.events, undefined as string | undefined),
  collections: toSnapshotStore(core.collections, core.events, []),
  events: toLogStore(core.events, 50),
  syncFailures: toLogStore(core.syncFailures, 10),
});
