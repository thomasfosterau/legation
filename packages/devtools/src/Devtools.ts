/**
 * Devtools
 *
 * The headless core over the introspection substrate (#120): all data
 * acquisition and every action live here as plain `Effect`/`Stream` values —
 * the same surfaces `@legation/svelte` already exposes bindings over — so a
 * framework panel (`@legation/devtools/svelte`) is a thin idiomatic UI over
 * one shared, tested read model, never its own data-acquisition path.
 *
 * Fed exclusively by already-public substrate (the `@legation/effect/internal`
 * entrypoint, the same one `@legation/svelte` itself depends on):
 * `Introspection` (subscriptions, cookie, collections),
 * `ClientEngine.mutationStates` (#116, the journal/mutation timeline —
 * including the `"dropped"` phase paced compaction settles a compacted entry
 * to, so a devtools timeline never shows a phantom in-flight mutation),
 * `ClientEngine.engineEvents` (the sync activity log), and
 * `ClientEngine.syncFailures`. Nothing here reaches into engine-private
 * state; a capability this core would need that isn't already exposed there
 * is substrate work, not a private hook.
 *
 * Scope: the owned-engine case only — an app that constructed its own
 * `ClientEngine` + `ClientStore` in this process. Attaching over the mirror
 * seam (a service-worker-hosted engine, ADR-0010/0021) needs a
 * mirror-protocol introspection extension that does not exist yet; that is
 * substrate work for a follow-up issue, not something this package works
 * around with a private hook of its own.
 */
import { Effect, Stream } from "effect";
import type { ClientStore, StoreError } from "@legation/effect";
import {
  Introspection,
  type ClientEngine,
  type MutationState,
  type Subset,
} from "@legation/effect/internal";

/** One collection's name plus its confirmed row count, for the subscriptions
 * & collections panel's "rows in window" summary. */
export interface CollectionSummary {
  readonly name: string;
  readonly rowCount: number;
}

/**
 * The optional simulated-offline control (built by `Transport.simulateOffline`
 * and wired into the app's transport at boot) — the devtools actions panel's
 * offline toggle. Omitted when the app never wired a toggleable transport, in
 * which case the panel simply doesn't render that action.
 */
export interface OfflineControl {
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly isOffline: Effect.Effect<boolean>;
}

export interface DevtoolsOptions {
  readonly offline?: OfflineControl;
}

/** The devtools headless core: one instance per engine, shared by every panel mounted over it. */
export interface DevtoolsCore {
  // ─── Journal & mutation timeline (panel #1) ──────────────────────────────
  /** The keyed, reactive mutation-state map (#116): re-emits on every fold. */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;

  // ─── Subscriptions & collections (panel #2) ──────────────────────────────
  /** Active subsets: collection, predicate, order, and window (limit/cursor). */
  readonly subscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>>;
  /** The current pull cookie, or `undefined` before the first pull. */
  readonly cookie: Effect.Effect<string | undefined, StoreError>;
  /** Every collection currently holding confirmed rows, with its row count. */
  readonly collections: Effect.Effect<ReadonlyArray<CollectionSummary>, StoreError>;

  // ─── Sync activity (panel #3) ────────────────────────────────────────────
  /** The unified sync-lifecycle event stream (push/pull/poke/mutation/rebuild). */
  readonly events: Stream.Stream<ClientEngine.EngineEvent>;
  /** Terminal sync failures (retry exhausted) — the "last error" surface. */
  readonly syncFailures: Stream.Stream<ClientEngine.SyncFailure>;

  // ─── Actions (panel #4) ──────────────────────────────────────────────────
  /** Push the journal now. */
  readonly forcePush: ClientEngine.ClientEngine["push"];
  /** Pull a patch now and rebase. */
  readonly forcePull: ClientEngine.ClientEngine["pull"];
  /** Drop an active subscription. */
  readonly dropSubscription: (subset: Subset.Subset) => Effect.Effect<void>;
  /** Destructive: clear every confirmed row from the store. Gate behind a confirm in the UI. */
  readonly clearStore: Effect.Effect<void, StoreError>;
  /** The simulated-offline toggle, if the app wired one — see {@link OfflineControl}. */
  readonly offline?: OfflineControl;
}

/** Build the devtools core over a running engine + its store. */
export const make = (
  engine: ClientEngine.ClientEngine,
  store: ClientStore.ClientStore,
  options?: DevtoolsOptions
): DevtoolsCore => {
  const introspection = Introspection.make(engine, store);

  const collections: Effect.Effect<
    ReadonlyArray<CollectionSummary>,
    StoreError
  > = introspection.collections.pipe(
    Effect.flatMap((names) =>
      Effect.forEach(names, (name) =>
        store
          .listRows(name)
          .pipe(Effect.map((rows): CollectionSummary => ({ name, rowCount: rows.length })))
      )
    )
  );

  return {
    mutationStates: engine.mutationStates,
    subscriptions: introspection.subscriptions,
    cookie: introspection.cookie,
    collections,
    events: introspection.events,
    syncFailures: engine.syncFailures,
    forcePush: engine.push,
    forcePull: engine.pull,
    dropSubscription: engine.unsubscribe,
    clearStore: store.clearRows,
    ...(options?.offline === undefined ? {} : { offline: options.offline }),
  };
};
