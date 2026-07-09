/**
 * MutationState
 *
 * A keyed, reactive mutation-state map (#116): the per-mutation lifecycle
 * `ClientEngine.mutationEvents` already streams, folded into a map anyone can
 * read as of now (`ClientEngine.mutationStates`) — TanStack Query's
 * `useMutationState` analogue. Seeded from the journal at boot (so a reload
 * shows pending intents), then folded forward as mutations are journaled,
 * acknowledged, and permanently rejected.
 *
 * The journal (`ClientStore.pendingMutations`) stays the durable source of
 * truth for *pending* mutations — this map never drops a pending entry.
 * Terminal entries (acknowledged/rejected) exist only for observability (a
 * success/failure toast, a "recently synced" indicator), so they are retained
 * up to a configurable bound and evicted oldest-settled-first beyond it —
 * bounded memory under a mutation storm without a background sweep.
 */

import type { Mutation } from "./Protocol.js";

export type MutationPhase = "pending" | "acknowledged" | "rejected";

/**
 * One mutation's lifecycle state, keyed by `mutationId` in {@link
 * MutationStateMap}. `args` is the journal's encoded (wire/persistence) form,
 * so the whole shape is serializable — devtools-timeline ready.
 */
export interface MutationState {
  readonly mutationId: number;
  readonly mutator: string;
  readonly args: unknown;
  readonly phase: MutationPhase;
  /** Set only when `phase` is `"rejected"`: the backend's permanent-rejection reason. */
  readonly reason?: string;
  /** Client wall-clock when the mutation was journaled. */
  readonly journaledAt: number;
  /** Client wall-clock when the mutation left `"pending"`; unset while pending. */
  readonly settledAt?: number;
}

export type MutationStateMap = ReadonlyMap<number, MutationState>;

export interface RetentionOptions {
  /**
   * Maximum terminal (acknowledged/rejected) entries retained; the
   * oldest-settled are evicted first once exceeded. Pending entries are never
   * evicted — they leave the map only by settling. Defaults to
   * {@link DEFAULT_MAX_TERMINAL}.
   */
  readonly maxTerminal?: number;
}

/**
 * Default terminal retention: generous enough that a normal session never
 * trims a state the UI still cares about, small enough to bound a storm.
 */
export const DEFAULT_MAX_TERMINAL = 200;

/** Seed the map from the journal at boot: every pending mutation starts `"pending"`. */
export const seed = (pending: ReadonlyArray<Mutation>): MutationStateMap => {
  const map = new Map<number, MutationState>();
  for (const mutation of pending) {
    map.set(mutation.mutationId, {
      mutationId: mutation.mutationId,
      mutator: mutation.mutator,
      args: mutation.args,
      phase: "pending",
      journaledAt: mutation.createdAt,
    });
  }
  return map;
};

/** Fold a freshly-journaled mutation in as `"pending"`. */
export const journaled = (
  map: MutationStateMap,
  entry: {
    readonly mutationId: number;
    readonly mutator: string;
    readonly args: unknown;
    readonly journaledAt: number;
  }
): MutationStateMap => {
  const next = new Map(map);
  next.set(entry.mutationId, {
    mutationId: entry.mutationId,
    mutator: entry.mutator,
    args: entry.args,
    phase: "pending",
    journaledAt: entry.journaledAt,
  });
  return next;
};

/**
 * Drop the oldest-settled terminal entries beyond `maxTerminal` (#116) — the
 * bound that keeps the map from growing without limit across a mutation
 * storm. Pending entries are never touched.
 */
const evictTerminal = (
  map: MutationStateMap,
  options: RetentionOptions | undefined
): MutationStateMap => {
  const maxTerminal = options?.maxTerminal ?? DEFAULT_MAX_TERMINAL;
  const terminal = [...map.values()]
    .filter((state) => state.phase !== "pending")
    .toSorted((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const excess = terminal.length - maxTerminal;
  if (excess <= 0) return map;
  const next = new Map(map);
  for (let i = 0; i < excess; i++) next.delete(terminal[i]!.mutationId);
  return next;
};

/** Fold a mutation's authoritative outcome in, then apply terminal retention. */
const settle = (
  map: MutationStateMap,
  mutationId: number,
  phase: "acknowledged" | "rejected",
  settledAt: number,
  reason: string | undefined,
  options: RetentionOptions | undefined
): MutationStateMap => {
  const current = map.get(mutationId);
  // Not tracked (already evicted, or settled before this engine instance
  // seeded its map): nothing to fold.
  if (current === undefined) return map;
  const next = new Map(map);
  next.set(mutationId, {
    ...current,
    phase,
    settledAt,
    ...(reason !== undefined ? { reason } : {}),
  });
  return evictTerminal(next, options);
};

/** Fold the backend's `applied` outcome in for one mutation. */
export const acknowledged = (
  map: MutationStateMap,
  mutationId: number,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap => settle(map, mutationId, "acknowledged", settledAt, undefined, options);

/** Fold the backend's permanent rejection in for one mutation. */
export const rejected = (
  map: MutationStateMap,
  mutationId: number,
  reason: string,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap => settle(map, mutationId, "rejected", settledAt, reason, options);
