/**
 * Telemetry
 *
 * Effect-native observability for the sync engine: a small set of metrics and
 * span names wired into the hot paths (client push/pull, server push/pull,
 * fan-out). Effect carries a `MetricRegistry` and `Tracer` in context, so
 * instrumentation here surfaces through whatever exporter the host installs
 * (OpenTelemetry, Prometheus, a test registry) with no extra dependency.
 *
 * Metric names follow the `effect_sync_*` convention; spans the
 * `effect-sync.*` convention.
 */

import { Effect, Metric } from "effect";

/** Pulls completed by a client (a patch applied + rebase). */
export const pullsTotal = Metric.counter("effect_sync_client_pulls_total", { incremental: true });

/** Pushes completed by a client. */
export const pushesTotal = Metric.counter("effect_sync_client_pushes_total", { incremental: true });

/** Mutations delivered upstream across all pushes. */
export const mutationsPushedTotal = Metric.counter("effect_sync_mutations_pushed_total", {
  incremental: true,
});

/** Pull requests served by the sync server. */
export const serverPullsTotal = Metric.counter("effect_sync_server_pulls_total", {
  incremental: true,
});

/** Pokes published by server fan-out. */
export const pokesTotal = Metric.counter("effect_sync_pokes_total", { incremental: true });

/** Patch sizes (ops per pull) computed by the server. */
export const patchOps = Metric.histogram("effect_sync_patch_ops", {
  boundaries: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500],
});

/** Record an integer count against a counter (no-op-safe in any context). */
export const count = <Input extends number>(
  metric: Metric.Metric<Input, unknown>,
  amount: Input
): Effect.Effect<void> => Metric.update(metric, amount);

/** Names used for `Effect.withSpan` on the engine's hot paths. */
export const span = {
  clientPull: "effect-sync.client.pull",
  clientPush: "effect-sync.client.push",
  serverPull: "effect-sync.server.pull",
  serverPush: "effect-sync.server.push",
} as const;
