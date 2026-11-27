---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

`RoomTransport`'s poke socket runs on `effect/socket` (`Socket.makeWebSocket`) and reconnects through `Stream.retry`, so a re-dial is interruptible and follows the `Clock` (testable with `TestClock`). The new `reconnect` option takes the re-dial `Schedule`; without it, `defaultReconnect(maxReconnectDelayMillis)` (also exported) keeps the old linear backoff of one more second per failed attempt, capped at `maxReconnectDelayMillis`, restarting once a frame arrives. `maxReconnectDelayMillis` keeps working. Two behaviour changes: a socket that has not opened within 10 seconds is abandoned and re-dialled, and a `reconnect` schedule that ends fails `pokes` with a `TransportError`. The socket's constructor can be replaced through `Socket.WebSocketConstructor` in the context.

`BindingTransport` sends through Effect's Fetch `HttpClient` over the binding's `fetch`, as `RoomTransport` does, and decodes each answer with the protocol's response schema: an answer that is not the protocol's response now fails with a `TransportError` ("binding /pull request failed") instead of reaching the engine unchecked.
