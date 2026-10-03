---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": patch
"@thomasfosterau/legation-node": patch
"@thomasfosterau/legation-jsonapi": patch
"@thomasfosterau/legation-sql": patch
"@thomasfosterau/legation-cloudflare": patch
"@thomasfosterau/legation-svelte": patch
"@thomasfosterau/legation-devtools": patch
---

Tested against `effect` 4.0.0 (and the matching `@effect/*` companions); the
peer floor is unchanged at `effect >=4.0.0-rc.118`.

`@thomasfosterau/legation-effect` adapts to 4.0.0's stricter, type-only `Schema.brand`:

- `Node.Id` keeps its signature and runtime behaviour; its internal brand
  identifier is cast to satisfy the new concrete-identifier check.
- `Node.AnyNode`'s `Id` property is now
  `Schema.Codec<string & Brand.Brand<string>, string>` instead of `Id<string>`.
  4.0.0's `brand<String, B>` is type-only and no longer assignable to a wider
  `brand<String, `${string}/id`>`, so no concrete `Node<"todos", …>` was
  assignable to `AnyNode`. Every concrete node is assignable again, and `Id`
  is still a string-encoded branded id schema; only code that reads `.Id` off
  an `AnyNode`-typed value sees the wider brand.

Checked the 4.0.0 behavioural changes against the packages and found no impact:
no use of `partition`/`separate`/`Option.partitionMap`, `Queue.State`,
`MessageStorage` or `RpcMessage.ExitEncoded`. The RPC client's missed-pong
handling now fails in-flight WebSocket calls rather than reporting a transient
error; `RpcTransport.fromOrigin` already treats a failed WebSocket call as a
`TransportError` and falls back to HTTP. `HttpSyncServer`'s WebSocket route now
closes with 1000/1001/1011, which nothing in the packages inspects.
