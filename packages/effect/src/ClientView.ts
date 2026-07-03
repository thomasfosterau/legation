/**
 * Client view
 *
 * The narrow surface a component binding needs — local reads (`query` /
 * `observe`), subscription registration, and write intents — abstracted over
 * *where* the engine runs. A main-thread {@link ClientEngine} satisfies it via
 * {@link fromEngine}; a tab's mirror (`TabMirror` in `@legation/browser`,
 * whose shape this interface is drawn from) satisfies it structurally. The
 * same bindings therefore drive both hosts of ADR-0010's deployment —
 * engine-in-the-tab and engine-in-the-service-worker — without changing
 * component code (ADR-0021).
 *
 * `mutateWithAck` has awaited-outcome semantics (it resolves with the
 * backend's authoritative {@link MutationOutcome}), matching the mirror; the
 * engine's handle-based variant is folded by {@link fromEngine}.
 *
 * Engine-only capabilities (named queries' server-authoritative registration,
 * explicit push/pull, undo history) are deliberately not part of this
 * surface — bindings that need them look the full engine up in context and
 * degrade with an actionable error when only a mirror is available.
 */
import { Context, Effect, Layer, Stream } from "effect";
import { ClientEngine, type LocalRow, type MutationOutcome } from "./ClientEngine.js";
import type { MutatorError, StoreError, TransportError } from "./Errors.js";
import type * as Subset from "./Subset.js";

/**
 * The union of what either host may fail a view operation with: the engine
 * fails on its store/mutators, a mirror on its channel. Each implementation's
 * channels are narrower.
 */
export type ClientViewError = MutatorError | StoreError | TransportError;

/** {@inheritDoc ClientViewError} */
export interface ClientView {
  /** Materialise a subset from the local view (confirmed + overlay). */
  readonly query: (
    subset: Subset.Subset
  ) => Effect.Effect<ReadonlyArray<LocalRow>, ClientViewError>;
  /** Live results of a subset, emitting current rows first. */
  readonly observe: (
    subset: Subset.Subset
  ) => Stream.Stream<ReadonlyArray<LocalRow>, ClientViewError>;
  /** Register/release a subscription (synced by the engine host). */
  readonly subscribe: (subset: Subset.Subset) => Effect.Effect<void, ClientViewError>;
  readonly unsubscribe: (subset: Subset.Subset) => Effect.Effect<void, ClientViewError>;
  /** Journal a mutation and apply it optimistically; resolves on journal. */
  readonly mutate: (mutator: string, args: unknown) => Effect.Effect<void, ClientViewError>;
  /** Like {@link ClientView.mutate}, resolving with the backend's authoritative outcome. */
  readonly mutateWithAck: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<MutationOutcome, ClientViewError>;
}

/** The read half of a {@link ClientView} — what a local join needs. */
export type Reader = Pick<ClientView, "query" | "observe">;

export const ClientView = Context.Service<ClientView>("@legation/effect/ClientView");

/** Present a {@link ClientEngine} as a {@link ClientView}. */
export const fromEngine = (engine: ClientEngine): ClientView => ({
  query: (subset) => engine.query(subset),
  observe: (subset) => engine.observe(subset),
  subscribe: (subset) => engine.subscribe(subset),
  unsubscribe: (subset) => engine.unsubscribe(subset),
  mutate: (mutator, args) => engine.mutate(mutator, args),
  mutateWithAck: (mutator, args) =>
    engine.mutateWithAck(mutator, args).pipe(Effect.flatMap((handle) => handle.acknowledged)),
});

/**
 * Derive the {@link ClientView} from the in-context engine. Compose with
 * `Layer.provideMerge(engineLayer)` so a runtime exposes both the view (for
 * bindings) and the engine (for engine-only capabilities).
 */
export const layer: Layer.Layer<ClientView, never, ClientEngine> = Layer.effect(ClientView)(
  Effect.map(ClientEngine, fromEngine)
);
