---
"@thomasfosterau/legation": minor
---

**Breaking:** `Authorization.IdentityResolver.resolve` now receives the request's credentials (ADR-0035, #219). Its signature is `(request: IdentityRequest) => Effect<unknown, AuthorizationError>`, where `IdentityRequest` is `{ clientGroupId, credentials }`; a resolver written as `(clientGroupId) => …` becomes `({ clientGroupId }) => …`.

- **`Authorization.RequestCredentials`** (new): an opaque, read-only view of the transport request's headers, with `header(name): Option<string>` (case-insensitive) and nothing that lists them; it prints as `RequestCredentials(<redacted>)`. Build one with **`Authorization.credentialsFromHeaders(headers)`** (a WHATWG `Headers`, any iterable of `[name, value]` pairs, or a plain record); **`Authorization.noCredentials`** has every header absent. **`Authorization.IdentityRequest`** and **`Authorization.CredentialHeaders`** are new types.
- Only the resolver sees the credentials: `SyncContext`, middleware, auth filters, logs, spans and errors are unchanged and never carry them. A failing `resolve` still fails the request; to fail closed to anonymous, return the anonymous identity instead.
- **`Transport.ServerHandler`**: `handlePush`, `handlePull` and `handleRead` take an optional second argument, **`Transport.HandleOptions`** (`{ credentials?: Option<RequestCredentials> }`); absent or `None` presents `noCredentials`. Existing callers compile unchanged.
- **`RpcTransport.layerHandlers`** presents each RPC call's headers (the HTTP request's, or the WebSocket upgrade request's, merged with headers the RPC client attached to the call) as its credentials.
- **`Transport.makeInMemory(handler, clientGroupId, options?)`** takes `{ credentials? }` (**`Transport.InMemoryOptions`**); without it the loopback presents `noCredentials`. **`Hydration.snapshot`** takes `credentials` for its in-process render, and **`Server.mutate`**'s `MutateRequest` takes `credentials` too.
