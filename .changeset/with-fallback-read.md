---
"@thomasfosterau/legation": patch
---

`Transport.withFallback` forwards the fallthrough `read` (ADR-0025): with both carriers offering it, a read tries the primary and falls back on a `TransportError` with the same sideline as push and pull; with one, that carrier serves it; with neither, the combined transport has none. `RpcTransport.fromOrigin`, and so `Client.make({ transport: { url } })`, now serves uncovered `Client.query` reads from the server instead of answering locally (#632).
