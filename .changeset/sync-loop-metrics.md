---
"@thomasfosterau/legation": minor
---

The client sync loop records three more metrics (on `Telemetry` in `@thomasfosterau/legation/internal`): `legation_client_sync_retries_total`, one per retry a push, pull or poke-stream policy schedules, with an `operation` attribute (`Telemetry.syncRetries(operation)` is one operation's series); `legation_client_pokes_received_total`; and `legation_client_poke_latency_ms`, the time from a poke arriving to the pull it started settling. The in-process `FanoutBroker` counts the poke batches a behind room's full hub drops (`legation_fanout_pokes_dropped_total`). Retry and fan-out behaviour are unchanged. `verifyBackendContract`'s doc comment shows it run from `@effect/vitest`'s `layer(...)`.
