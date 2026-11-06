---
"@thomasfosterau/legation": minor
---

Add the `@thomasfosterau/legation/sql` entry point: the driver-agnostic SQL reference backend (`Sql`, `SqlBackend`, `PgExecutor`, `PollingHintSource`), merged in from the former `@thomasfosterau/legation-sql` package, which was never published (ADR-0033). It needs only `effect`, and the root and `./internal` entries don't load it. Import these modules from `@thomasfosterau/legation/sql`.

`@thomasfosterau/legation-node` is gone (also never published): no consumer runs a Node server. Its `HttpSyncServer` layers were `effect/rpc`'s `RpcServer.layer(RpcTransport.SyncRpcs)` over `RpcTransport.layerHandlers` and an HTTP or WebSocket protocol with NDJSON framing; an app serving the sync RPCs from Node composes those itself (`examples/commerce/server/carriers.ts`).
