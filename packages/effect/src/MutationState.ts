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
 *
 * Backed by `HashMap` (structural sharing), not the native `Map`: `journal()`
 * folds one entry in on every mutation (ADR/#109's own hot path), so an
 * `O(size)` copy per fold would make a burst of N mutations cost `O(N^2)` —
 * exactly the class of regression #109 eliminated for the overlay. `HashMap`
 * keeps every fold `O(log N)` regardless of how many mutations are pending.
 */

import { HashMap, Option } from "effect";
import type { Mutation } from "./Protocol.js";

/** Where a journaled mutation is in its lifecycle. */
export type MutationPhase = "pending" | "acknowledged" | "rejected" | "dropped";

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

/** Every tracked mutation's {@link MutationState}, keyed by `mutationId`. */
export type MutationStateMap = HashMap.HashMap<number, MutationState>;

/** How many settled entries a {@link MutationStateMap} keeps. */
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
export const seed = (pending: ReadonlyArray<Mutation>): MutationStateMap =>
  HashMap.fromIterable(
    pending.map((mutation): readonly [number, MutationState] => [
      mutation.mutationId,
      {
        mutationId: mutation.mutationId,
        mutator: mutation.mutator,
        args: mutation.args,
        phase: "pending",
        journaledAt: mutation.createdAt,
      },
    ])
  );

/** Fold a freshly-journaled mutation in as `"pending"`. */
export const journaled = (
  map: MutationStateMap,
  entry: {
    readonly mutationId: number;
    readonly mutator: string;
    readonly args: unknown;
    readonly journaledAt: number;
  }
): MutationStateMap =>
  HashMap.set(map, entry.mutationId, {
    mutationId: entry.mutationId,
    mutator: entry.mutator,
    args: entry.args,
    phase: "pending",
    journaledAt: entry.journaledAt,
  });

/**
 * Drop the oldest-settled terminal entries beyond `maxTerminal` (#116) — the
 * bound that keeps the map from growing without limit across a mutation
 * storm. Pending entries are never touched. `O(size)`: scans every entry to
 * find the terminal ones, so callers settling many mutations at once (a push
 * ack sweep) should fold every transition first and evict once — see
 * {@link acknowledgedMany} — rather than evicting after each one.
 */
const evictTerminal = (
  map: MutationStateMap,
  options: RetentionOptions | undefined
): MutationStateMap => {
  const maxTerminal = options?.maxTerminal ?? DEFAULT_MAX_TERMINAL;
  const terminal = [...HashMap.values(map)]
    .filter((state) => state.phase !== "pending")
    .toSorted((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const excess = terminal.length - maxTerminal;
  if (excess <= 0) return map;
  let next = map;
  for (let i = 0; i < excess; i++) next = HashMap.remove(next, terminal[i]!.mutationId);
  return next;
};

/**
 * The phase a mutation is in, or `undefined` when it is not tracked (already
 * evicted, or settled before this engine instance seeded its map).
 */
export const phaseOf = (map: MutationStateMap, mutationId: number): MutationPhase | undefined =>
  Option.getOrUndefined(Option.map(HashMap.get(map, mutationId), (state) => state.phase));

/**
 * Fold one mutation's terminal outcome in, without applying retention. Only a
 * `"pending"` entry moves (#364): a settled phase is never overwritten, so the
 * first outcome the client observed stands and a later, repeated or
 * contradictory report folds nothing.
 */
const transition = (
  map: MutationStateMap,
  mutationId: number,
  phase: "acknowledged" | "rejected" | "dropped",
  settledAt: number,
  reason: string | undefined
): MutationStateMap => {
  const current = HashMap.get(map, mutationId);
  // Not tracked (already evicted, or settled before this engine instance
  // seeded its map), or already settled: nothing to fold.
  if (Option.isNone(current) || current.value.phase !== "pending") return map;
  return HashMap.set(map, mutationId, {
    ...current.value,
    phase,
    settledAt,
    ...(reason !== undefined ? { reason } : {}),
  });
};

/** Fold the backend's `applied` outcome in for one mutation, then apply terminal retention. */
export const acknowledged = (
  map: MutationStateMap,
  mutationId: number,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap =>
  evictTerminal(transition(map, mutationId, "acknowledged", settledAt, undefined), options);

/** Fold the backend's permanent rejection in for one mutation, then apply terminal retention. */
export const rejected = (
  map: MutationStateMap,
  mutationId: number,
  reason: string,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap =>
  evictTerminal(transition(map, mutationId, "rejected", settledAt, reason), options);

/**
 * Fold a paced-compaction drop in for one mutation (`ClientEngine.dropIfPending`,
 * #117's debounce/throttle/coalesce strategies superseding a still-unpushed
 * entry), then apply terminal retention. Unlike {@link acknowledged} /
 * {@link rejected}, this is not a backend verdict — the entry never reached the
 * backend — but it must still leave `"pending"`: left untouched, a compacted
 * entry would stay `"pending"` forever (the journal no longer has it, but
 * nothing ever transitions the state map), a permanently stale entry a
 * mutation-timeline consumer (a devtools journal panel) would show as
 * eternally in flight.
 */
export const dropped = (
  map: MutationStateMap,
  mutationId: number,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap =>
  evictTerminal(transition(map, mutationId, "dropped", settledAt, undefined), options);

/**
 * Fold a batch of paced-compaction drops in, then apply terminal retention
 * exactly once — see {@link acknowledgedMany}'s rationale: `evictTerminal` is
 * `O(size)`, so folding every transition first and evicting once keeps a
 * K-entry drop `O(size)` rather than `O(K * size)`.
 */
export const droppedMany = (
  map: MutationStateMap,
  mutationIds: ReadonlyArray<number>,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap => {
  let next = map;
  for (const mutationId of mutationIds) {
    next = transition(next, mutationId, "dropped", settledAt, undefined);
  }
  return evictTerminal(next, options);
};

/**
 * Fold a paced compaction in (#117, #249): the `dropped` ids settle as
 * `"dropped"`, and each `renumbered` survivor's still-`"pending"` state moves
 * from its old id to its new one (the `mutationId` field follows the key).
 * The map is keyed by id and a survivor may take an id a dropped entry just
 * vacated, so the survivor wins the slot — the dropped record for that id is
 * overwritten (the `dropped` lifecycle event is still emitted). Retention is
 * applied once, after everything has moved.
 */
export const compacted = (
  map: MutationStateMap,
  compaction: {
    readonly dropped: ReadonlyArray<number>;
    readonly renumbered: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  },
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap => {
  let next = map;
  for (const mutationId of compaction.dropped) {
    next = transition(next, mutationId, "dropped", settledAt, undefined);
  }
  const moved: Array<MutationState> = [];
  for (const { from, to } of compaction.renumbered) {
    const current = HashMap.get(next, from);
    if (Option.isNone(current)) continue;
    moved.push({ ...current.value, mutationId: to });
    next = HashMap.remove(next, from);
  }
  for (const state of moved) next = HashMap.set(next, state.mutationId, state);
  return evictTerminal(next, options);
};

/**
 * Fold a push ack sweep's whole batch of newly-applied mutation ids in, then
 * apply terminal retention exactly once — not once per id. `settleApplied`
 * (ClientEngine.ts) can settle every still-pending id at or below a push's
 * `lastMutationId` in one sweep; folding each through {@link acknowledged}
 * individually would re-scan the whole map (`evictTerminal` is `O(size)`)
 * once per settled id, an `O(K*size)` cost for a K-mutation sweep.
 */
export const acknowledgedMany = (
  map: MutationStateMap,
  mutationIds: ReadonlyArray<number>,
  settledAt: number,
  options?: RetentionOptions
): MutationStateMap => {
  let next = map;
  for (const mutationId of mutationIds) {
    next = transition(next, mutationId, "acknowledged", settledAt, undefined);
  }
  return evictTerminal(next, options);
};
