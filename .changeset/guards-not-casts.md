---
"@thomasfosterau/legation": patch
"@thomasfosterau/legation-alchemy-cloudflare": patch
---

A few reads of untyped values use guards instead of casts. Valid data behaves as before; on malformed data, `BackendContract` reads a non-numeric counter row as absent, and the Durable Object binding transport falls back to its default message for a non-string error body.
