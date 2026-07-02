---
"@legation/effect": minor
---

Add `Subscriptions`: subscription lifecycle on top of `ClientEngine` —
reference-counted `acquire`/`release`, a TTL grace period before an unused
subscription is dropped (default 5 minutes), and `preload`/`preloadQuery` to
pin a subscription for the session. Releasing keeps the rows for the grace
window so a quick re-subscribe reuses them; if the grace elapses the engine
unsubscribes and the next pull drops the rows. This is the read-side lifecycle
Zero expresses as query `ttl` and `preload()`, built on named queries or raw
subsets.
