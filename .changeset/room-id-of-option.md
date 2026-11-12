---
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

**Breaking:** `Worker.RouterConfig.roomIdOf` returns `Effect<Option<string>, never, R>` instead of `Effect<string | undefined, never, R>` (#683), matching `anonymousRoomOf`. `Option.none()` is the anonymous caller (a 401, unless `anonymousRoomOf` routes it). Migrate by wrapping the result: `Option.fromNullishOr(id)` for a nullable lookup, or `Effect.succeed(Option.some(id))` for a constant id.
