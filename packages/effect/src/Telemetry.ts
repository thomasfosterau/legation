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

/** Patch sizes (ops per pull) computed by the server. */
export const patchOps = Metric.histogram("legation_patch_ops", {
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
} as const;
