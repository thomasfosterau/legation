# @legation/browser

Browser-runtime adapters for the legation engine: service-worker engine host, IndexedDB client store, tab mirrors over BroadcastChannel, and a Cache API HTTP cache.

> This README is a stub while the API settles before 1.0; the full reference is being rewritten ([#266](https://github.com/thomasfosterau/legation/issues/266)). Until then, see the [root README](../../README.md) (its "Browser topology" section covers the service-worker host and the elected main-thread host) and the [`commerce` example](../../examples/commerce), which runs the engine in a service worker.

## Install

```sh
npm install @legation/browser @legation/effect effect @effect/platform-browser
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. `@effect/platform-browser` is peered with the same floor. Tested against `4.0.0-rc.118` (both the floor and the version CI pins); install one copy of `effect` in your app (ADR-0003).

## License

MIT
