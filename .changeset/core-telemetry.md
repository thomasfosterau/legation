---
"@thomasfosterau/legation-effect": minor
---

Add Effect-native observability (`Telemetry`): `legation_*` metrics and
`legation.*` spans wired into the engine's hot paths — client push/pull,
server push/pull, and fan-out. Counters (pulls, pushes, mutations pushed,
server pulls, pokes) and a patch-size histogram surface through whatever
`MetricRegistry`/`Tracer` exporter the host installs (OpenTelemetry,
Prometheus, …) with no extra dependency. Closes the observability gap from the
Zero feature-parity audit.
