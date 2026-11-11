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
 *
 * The same view reaches across the mirror seam (#136): an engine host given
 * its store (`EngineHost.run({ store })`) serves {@link requests}, the
 * host-request kinds that carry each member, and {@link fromMirror} builds an
 * `EngineIntrospection` over them in any tab holding a `Mirror`. Its members
 * fail with a `HostRequestError` where the owned view cannot fail.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ClientEngine,
  type EngineEvent as EngineEventType,
  type SyncFailure as SyncFailureType,
} from "./ClientEngine.js";
import { ClientStore } from "./ClientStore.js";
import { MutatorError, StoreError, TransportError } from "./Errors.js";
import * as HostRequest from "./HostRequest.js";
import * as Protocol from "./Protocol.js";
import * as Subset from "./Subset.js";

/**
 * A read-only introspection surface over an engine + store. `subscriptions`,
 * `syncFailures` and `events` read the engine; `journal`, `cookie`, and
 * `collections` read the store — all public reads, no private access. `E` is
 * the extra failure of a view read from elsewhere: `never` for
 * {@link make}'s, `HostRequestError` for {@link fromMirror}'s.
 */
export interface EngineIntrospection<E = never> {
  /** Active subsets: raw subscriptions plus each named subscription resolved. */
  readonly subscriptions: Effect.Effect<ReadonlyArray<Subset.Subset>, E>;
  /**
   * The journal: pending (unacknowledged) mutations in causal order. It holds
   * pending entries only. A mutation the backend acknowledged but no pull has
   * reported yet is in the engine's unpulled tail (#286), which this view does
   * not show.
   */
  readonly journal: Effect.Effect<ReadonlyArray<Protocol.Mutation>, StoreError | E>;
  /** The current pull cookie, or `undefined` before the first pull. */
  readonly cookie: Effect.Effect<string | undefined, StoreError | E>;
  /** Every collection currently holding confirmed rows. */
  readonly collections: Effect.Effect<ReadonlyArray<string>, StoreError | E>;
  /** The most recent terminal sync failures, oldest first (`ClientEngine.recentSyncFailures`). */
  readonly syncFailures: Effect.Effect<ReadonlyArray<SyncFailureType>, E>;
  /** The unified sync-lifecycle event stream (see {@link EngineEvent}). */
  readonly events: Stream.Stream<EngineEventType, E>;
}

/** The {@link EngineIntrospection} service devtools read through. */
export const EngineIntrospection = Context.Service<EngineIntrospection>(
  "@thomasfosterau/legation/EngineIntrospection"
);

/** Build the introspection view over a given engine and store. */
export const make = (engine: ClientEngine, store: ClientStore): EngineIntrospection => ({
  subscriptions: engine.activeSubscriptions,
  journal: store.pendingMutations,
  cookie: store.getCookie,
  collections: store.listCollections,
  syncFailures: engine.recentSyncFailures,
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

// ─── Over the mirror seam (#136) ─────────────────────────────────────────────

/** Wire codec for one `ClientEngine.EngineEvent`. */
export const EngineEvent: Schema.Codec<EngineEventType, unknown> = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("MutationJournaled"),
    clientId: Schema.String,
    mutationId: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("MutationAcknowledged"),
    clientId: Schema.String,
    mutationId: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("MutationRejected"),
    clientId: Schema.String,
    mutationId: Schema.Finite,
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("MutationDropped"),
    clientId: Schema.String,
    mutationId: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("MutationRenumbered"),
    clientId: Schema.String,
    previousMutationId: Schema.Finite,
    mutationId: Schema.Finite,
  }),
  Schema.Struct({ _tag: Schema.tag("PushStarted") }),
  Schema.Struct({ _tag: Schema.tag("PushCompleted"), mutations: Schema.Finite }),
  Schema.Struct({ _tag: Schema.tag("PullStarted") }),
  Schema.Struct({
    _tag: Schema.tag("PullCompleted"),
    ops: Schema.Finite,
    collections: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Struct({ collection: Schema.String, id: Schema.String })),
  }),
  Schema.Struct({ _tag: Schema.tag("PokeReceived"), reason: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    _tag: Schema.tag("ViewRebuilt"),
    collections: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    _tag: Schema.tag("UpdateNeeded"),
    schemaVersion: Schema.optionalKey(Schema.String),
    message: Schema.String,
  }),
]);

/** The type {@link EngineEvent} decodes to: `ClientEngine.EngineEvent`. */
export type EngineEvent = typeof EngineEvent.Type;

/** Wire codec for one `ClientEngine.SyncFailure`: its operation and its tagged error. */
export const SyncFailure: Schema.Codec<SyncFailureType, unknown> = Schema.Struct({
  operation: Schema.Literals(["push", "pull", "pokes"]),
  error: Schema.Union([TransportError, StoreError, MutatorError]),
});

/** The type {@link SyncFailure} decodes to: `ClientEngine.SyncFailure`. */
export type SyncFailure = typeof SyncFailure.Type;

/**
 * The introspection request kinds (ADR-0021 amendment §7), each typed by the
 * {@link EngineIntrospection} member it serves: single-reply
 * `introspect/subscriptions`, `introspect/journal`, `introspect/cookie`,
 * `introspect/collections` and `introspect/syncFailures`, and streaming
 * `introspect/events`. Mutation states are not among them: a mirror follows
 * them through `Mirror.mutationStates` (#116).
 */
export const requests = {
  subscriptions: HostRequest.single("introspect/subscriptions", {
    request: HostRequest.NoInput,
    response: Schema.Array(Subset.Subset),
  }),
  journal: HostRequest.single("introspect/journal", {
    request: HostRequest.NoInput,
    response: Schema.Array(Protocol.Mutation),
  }),
  cookie: HostRequest.single("introspect/cookie", {
    request: HostRequest.NoInput,
    response: Schema.UndefinedOr(Schema.String),
  }),
  collections: HostRequest.single("introspect/collections", {
    request: HostRequest.NoInput,
    response: Schema.Array(Schema.String),
  }),
  syncFailures: HostRequest.single("introspect/syncFailures", {
    request: HostRequest.NoInput,
    response: Schema.Array(SyncFailure),
  }),
  events: HostRequest.streaming("introspect/events", {
    request: HostRequest.NoInput,
    response: EngineEvent,
  }),
} as const;

/** The host-side handlers serving {@link requests} from an introspection view. */
export const handlers = <E>(
  introspection: EngineIntrospection<E>
): ReadonlyArray<HostRequest.Handler> => [
  HostRequest.handler(requests.subscriptions, () => introspection.subscriptions),
  HostRequest.handler(requests.journal, () => introspection.journal),
  HostRequest.handler(requests.cookie, () => introspection.cookie),
  HostRequest.handler(requests.collections, () => introspection.collections),
  HostRequest.handler(requests.syncFailures, () => introspection.syncFailures),
  HostRequest.streamHandler(requests.events, () => introspection.events),
];

/**
 * Build the introspection view of the engine a mirror's host runs (#136), over
 * {@link requests}. Each read is one host request; `events` follows the host's
 * stream for as long as it is consumed. A host that does not serve these kinds
 * (no `store` given to `EngineHost.run`) answers `UnknownKind`; one that
 * predates host requests leaves the reads `Unanswered`.
 */
export const fromMirror = (
  mirror: HostRequest.Requester
): EngineIntrospection<HostRequest.HostRequestError> => ({
  subscriptions: mirror.request(requests.subscriptions, {}),
  journal: mirror.request(requests.journal, {}),
  cookie: mirror.request(requests.cookie, {}),
  collections: mirror.request(requests.collections, {}),
  syncFailures: mirror.request(requests.syncFailures, {}),
  events: mirror.stream(requests.events, {}),
});
