---
"@thomasfosterau/legation": minor
---

**`Authorization.resolveContext(resolver, request)`** (new) builds the `SyncContext` a request runs under: the client group it names and the identity an optional `IdentityResolver` resolves from its credentials (ADR-0035). The sync server builds every push, pull and read context with it, and so does `RestHandlers` (#645).
