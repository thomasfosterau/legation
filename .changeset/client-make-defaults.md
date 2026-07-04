---
"@legation/effect": minor
---

`Client.make` gains sensible defaults with full extensibility. Zero wiring works: `Client.make({ nodes, mutations })` is a purely local Client — in-memory store, offline transport (reads and optimistic writes work, the journal retains every intent), sync loop off. `transport: { url }` builds the standard remote setup (sync RPCs over WebSocket with HTTP fallback, via the new `RpcTransport.fromOrigin`); `store`/`transport` accept full implementations; a `ClientStore`/`ClientTransport` in context is still honoured (options win over context, context over defaults), so existing layer-composed apps are unchanged. `clientId`/`clientGroupId` default to random ids — pass stable ones alongside a persistent store. Also adds `Transport.offline`, and `Client.make` no longer _requires_ the store/transport services in its environment type.
