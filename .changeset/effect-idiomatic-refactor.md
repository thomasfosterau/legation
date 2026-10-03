---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-node": minor
---

Effect-idiomatic API refactor:

- Protocol messages (`ClientMessage`, `ServerMessage`, `PushResult`, `WireKeyFilter`), cache
  events (`CacheEvent`), and outbox events (`OutboxEvent`) are now `Data.TaggedEnum`s with
  generated constructors, `$is` guards, and exhaustive `$match` matchers
  (e.g. `Protocol.ClientMessage.Subscribe({...})`). The types are structurally unchanged, so
  existing object-literal construction still compiles.
- `SyncCacheDefaults` `Context.Reference` for ambient cache timing defaults
  (staleTime / timeToLive / staleWhileRevalidate).
- The cache's in-flight dedupe map uses `MutableHashMap`; background stale-while-revalidate
  refresh failures are now logged instead of silently swallowed.
- The WebSocket transports validate incoming frames with `ProtocolSchema` codecs instead of
  unchecked `JSON.parse` casts, and bridge socket events into Effect without `Effect.runFork`
  inside callbacks.
- All tests use `@effect/vitest` (`it.effect` / `it.live` / `it.layer`, `TestClock`).
