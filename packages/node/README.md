# @legation/node

Node-runtime adapters for the legation engine: serving the default RPC sync transport over HTTP and WebSocket.

> This README is a stub while the API settles before 1.0; the full reference is being rewritten ([#266](https://github.com/thomasfosterau/legation/issues/266)). The package exports `HttpSyncServer`, which registers the sync RPCs on an `HttpRouter` over HTTP POST or WebSockets. See the [root README](../../README.md) and the [`commerce` example](../../examples/commerce), which runs a real sync server.

## Install

```sh
npm install @legation/node @legation/effect effect @effect/platform-node
```

`@effect/platform-node` declares a peer on `redis` (`>=5.0.0 <7.0.0`), so a
package manager that checks peers may warn when it is missing. This package
doesn't need it: it imports `@effect/platform-node/NodeHttpServer` by subpath,
never the package root (whose `NodeRedis` re-export imports `redis` at module
load), so it loads without `redis` installed. If your app skips peers
(`--legacy-peer-deps`, `auto-install-peers=false`), import by subpath in your
own code too (`@effect/platform-node/NodeRuntime`, …): without `redis`, the
root fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'redis'`.

## Effect version

Peers `effect >=4.0.0-rc.118`, the floor `@thomasfosterau/effect-jsonapi` publishes. `@effect/platform-node` is peered with the same floor. Tested against `4.0.0` (the version CI pins) and `4.0.0-rc.118` (the floor; CI runs the tests against it on every PR); install one copy of `effect` in your app (ADR-0003).

Requires Node.js 22 or newer (`engines.node: ">=22"`), the Node line CI runs.

## License

MIT
