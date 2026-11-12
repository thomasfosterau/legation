---
"@thomasfosterau/legation-alchemy-cloudflare": patch
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-jsonapi": patch
---

Name the failures of the promises these packages await. A rejected KV delete, cache purge or forwarded invalidation (`EdgeInvalidation`), a rejected Background Sync registration lookup or registration (`BackgroundSync`) and an unreadable write-request body (`JsonApiFacade`) now carry a module-private tagged error with the rejection as its `cause`, where they were the generic `UnknownError`. Behaviour is unchanged; only the error a log line shows differs.
