---
"@thomasfosterau/legation-effect": minor
---

Retry/backoff policies for the sync loop (#34). `ClientEngineOptions.retry`
takes per-leg `Schedule`s for `push`, `pull`, and the `pokes` stream; unset
legs use `defaultRetryPolicy` (exponential from 1s, factor 2, delay capped at
30s, bounded to 5 retries — mirroring TanStack Query's 1s→30s, no jitter so it
composes predictably).

`runSync` now applies the policy instead of swallowing failures: only
`TransportError` is retried (`StoreError`/`MutatorError` are not transient and
propagate immediately), and the poke stream re-establishes with backoff via
`Stream.retry`. Terminal failures after policy exhaustion are surfaced on a new
`ClientEngine.syncFailures` stream and counted in
`Telemetry.syncFailuresTotal`, so bindings can show a "sync degraded" state.

The retry policy composes with the #33 scheduler: the scheduler decides when to
attempt, the policy decides how an attempt survives transient failure.
