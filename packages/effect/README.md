# @legation/effect

An Effect-native sync engine: write-through caching, TanStack-Query-style client queries/mutations/subscriptions, offline outbox, HTTP caching for service workers and edge runtimes, and a server-side sync hub with client fan-out.

> This README is a stub while the API settles before 1.0; the full reference is being rewritten ([#266](https://github.com/thomasfosterau/legation/issues/266)). Until then, start from the [root README](https://github.com/thomasfosterau/legation#readme), which has a compiling quick start, and the [example apps](https://github.com/thomasfosterau/legation/tree/trunk/examples). The app-facing surface is the root entry (`@legation/effect`); engine seams for adapter authors are on `@legation/effect/internal`.

## Install

```sh
npm install @legation/effect effect
```

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. Tested against `4.0.0-rc.118` (both the floor and the version CI pins); install one copy of `effect` in your app (ADR-0003).

## License

MIT
