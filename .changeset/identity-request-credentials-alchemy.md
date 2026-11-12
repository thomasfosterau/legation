---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

The room (`Room.make`) presents each push, pull and read request's headers to its `identity` resolver as `Authorization.RequestCredentials` (ADR-0035, #219), so a resolver can verify the session cookie or API key the request carried. A resolver now has the core's new signature, `({ clientGroupId, credentials }) => …`.
