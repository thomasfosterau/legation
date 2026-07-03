/**
 * Telemetry
 *
 * Effect-native observability for the sync engine: a small set of metrics and
 * span names wired into the hot paths (client push/pull, server push/pull,
 * fan-out). Effect carries a `MetricRegistry` and `Tracer` in context, so
 * instrumentation here surfaces through whatever exporter the host installs
 * (OpenTelemetry, Prometheus, a test registry) with no extra dependency.
 *
 * Metric names follow the `legation_*` convention; spans the
 * `legation.*` convention.
 */

import { Effect, Metric } from "effect";

/** Pulls completed by a client (a patch applied + rebase). */
export const pullsTotal = Metric.counter("legation_client_pulls_total", { incremental: true });

/** Pushes completed by a client. */
export const pushesTotal = Metric.counter("legation_client_pushes_total", { incremental: true });

/** Mutations delivered upstream across all pushes. */
export const mutationsPushedTotal = Metric.counter("legation_mutations_pushed_total", {
  incremental: true,
});

/** Pull requests served by the sync server. */
export const serverPullsTotal = Metric.counter("legation_server_pulls_total", {
  incremental: true,
});

/** Pokes published by server fan-out. */
export const pokesTotal = Metric.counter("legation_pokes_total", { incremental: true });

/**
 * Pokes suppressed by predicate-level fan-out matching: a group that a
 * collection-only match would have poked, but whose subscriptions no hinted
 * change plausibly affects. Over-matching is safe (a redundant poke costs an
 * empty pull), so this counts avoided-but-safe work, not correctness.
 */
export const pokesSuppressedTotal = Metric.counter("legation_pokes_suppressed_total", {
  incremental: true,
});

/** Patch sizes (ops per pull) computed by the server. */
export const patchOps = Metric.histogram("legation_patch_ops", {
  boundaries: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500],
});

/**
 * Sync operations (push/pull/poke stream) that failed terminally after the
 * client's retry policy was exhausted. A rising count means the transport is
 * degraded — bindings can surface a "sync degraded" state from it.
 */
export const syncFailuresTotal = Metric.counter("legation_client_sync_failures_total", {
  incremental: true,
});

/**
 * Invalidation-bus hints dropped because a bounded bus (in-process PubSub or
 * memory broker) overflowed while a consumer was behind. A dropped hint only
 * delays convergence — the next pull repairs it — so this counts safely-shed
 * work under backpressure, never lost correctness (ADR-0009).
 */
export const hintsDroppedTotal = Metric.counter("legation_hints_dropped_total", {
  incremental: true,
});

/**
 * Times a stalled engine observer's bounded change hub dropped a view-change,
 * forcing the consumer to collapse the gap into a full `Rebuild`. A Rebuild
 * subsumes any dropped `Patch`es (ADR-0008), so the view stays correct; this
 * counts backpressure-induced recomputes, not lost updates.
 */
export const changeCollapsesTotal = Metric.counter("legation_change_collapses_total", {
  incremental: true,
});

/**
 * Times a stalled mirror observer's bounded change hub dropped a subset
 * key, forcing a full re-read of the observed subset. The newest rows live in
 * the mirror's `Ref`, so the re-read is lossless; this counts refreshes forced
 * by backpressure.
 */
export const mirrorRefreshesTotal = Metric.counter("legation_mirror_refreshes_total", {
  incremental: true,
});

/**
 * Depth of the client's journal — the number of pending (unacknowledged)
 * mutations. Sampled as an absolute gauge on every append (a new pending
 * mutation) and every acknowledgement (a trim), so it tracks the outbox
 * backlog: a persistently high value means pushes are not draining.
 */
export const journalDepth = Metric.gauge("legation_journal_depth");

/**
 * Time (ms) to rebuild the optimistic overlay — the rebase (ADR-0008): replay
 * every pending mutation over confirmed rows. Sampled around the actual
 * materialisation (cache misses only), so it measures replay cost, not cache
 * hits.
 */
export const rebaseDurationMs = Metric.histogram("legation_rebase_duration_ms", {
  boundaries: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
});

/**
 * Time (ms) the server fan-out loop spends processing one hint batch — from
 * taking the batch off the invalidation bus to poking every matching group.
 * A proxy for hint-published → poke-sent latency (the hints carry no publish
 * timestamp), so it measures the fan-out leg the server controls.
 */
export const fanoutLatencyMs = Metric.histogram("legation_fanout_latency_ms", {
  boundaries: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500],
});

/** Patch size (ops) a client applies per pull — the downstream volume per rebase. */
export const pullPatchOps = Metric.histogram("legation_pull_patch_ops", {
  boundaries: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500],
});

/** Mutations delivered per push — the upstream batch size the journal coalesced. */
export const pushMutations = Metric.histogram("legation_push_mutations", {
  boundaries: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500],
});

/** Record an integer count against a counter (no-op-safe in any context). */
export const count = <Input extends number>(
  metric: Metric.Metric<Input, unknown>,
  amount: Input
): Effect.Effect<void> => Metric.update(metric, amount);

/** Names used for `Effect.withSpan` on the engine's hot paths. */
export const span = {
  clientPull: "legation.client.pull",
  clientPush: "legation.client.push",
  serverPull: "legation.server.pull",
  serverPush: "legation.server.push",
  serverRead: "legation.server.read",
} as const;
