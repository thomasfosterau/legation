/**
 * Introspection
 *
 * A read-only view of a running {@link ClientEngine} and its
 * {@link ClientStore} (#45): the active subscriptions, the pending-mutation
 * journal, the pull cookie, the materialised collections, and the unified
 * {@link ClientEngine.engineEvents} lifecycle stream. Built entirely over the
 * engine's public read accessors and the store's public reads — it never
 * reaches into private engine state.
 *
 * Every member is a plain `Effect`/`Stream`, so it drives cleanly through
 * `PromiseFacade` for non-Effect surfaces (devtools panels, a demo journal
 * view):
 *
 * ```ts
 * const intro = Introspection.make(engine, store);
 * const pending = await facade.run(intro.journal);
 * const sub = facade.subscribe(intro.events, {
 *   onValue: (event) => console.log(event._tag),
 * });
 * ```
 */

import { Context, Effect, Layer, Stream } from "effect";
import { ClientEngine, type EngineEvent } from "./ClientEngine.js";
import { ClientStore } from "./ClientStore.js";
import type { StoreError } from "./Errors.js";
import type { Mutation } from "./Protocol.js";
import type * as Subset from "./Subset.js";

/**
 * A read-only introspection surface over an engine + store. `subscriptions`
 * and `events` read the engine; `journal`, `cookie`, and `collections` read
 * the store — all public reads, no private access.
 */
export interface EngineIntrospection {
  /** Active subsets: raw subscriptions plus each named subscription resolved. */
  readonly subscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>>;
  /** The journal: pending (unacknowledged) mutations in causal order. */
  readonly journal: Effect.Effect<ReadonlyArray<Mutation>, StoreError>;
  /** The current pull cookie, or `undefined` before the first pull. */
  readonly cookie: Effect.Effect<string | undefined, StoreError>;
  /** Every collection currently holding confirmed rows. */
  readonly collections: Effect.Effect<ReadonlyArray<string>, StoreError>;
  /** The unified sync-lifecycle event stream (see {@link EngineEvent}). */
  readonly events: Stream.Stream<EngineEvent>;
}

/** The {@link EngineIntrospection} service devtools read through. */
export const EngineIntrospection = Context.Service<EngineIntrospection>(
  "@thomasfosterau/legation-effect/EngineIntrospection"
);

/** Build the introspection view over a given engine and store. */
export const make = (engine: ClientEngine, store: ClientStore): EngineIntrospection => ({
  subscriptions: engine.activeSubscriptions,
  journal: store.pendingMutations,
  cookie: store.getCookie,
  collections: store.listCollections,
  events: engine.engineEvents,
});

/** Build the view from the {@link ClientEngine} + {@link ClientStore} in context. */
export const fromServices: Effect.Effect<EngineIntrospection, never, ClientEngine | ClientStore> =
  Effect.gen(function* () {
    const engine = yield* ClientEngine;
    const store = yield* ClientStore;
    return make(engine, store);
  });

/** Layer providing {@link EngineIntrospection} from the engine + store services. */
export const layer: Layer.Layer<EngineIntrospection, never, ClientEngine | ClientStore> =
  Layer.effect(EngineIntrospection)(fromServices);
