# ADR-0035: Identity resolution sees the request's credentials

Date: 2026-11-12
Status: Accepted (#219). Amends in part [ADR-0015](0015-relationship-scoped-read-auth.md) (the identity seam's signature).

## Context

ADR-0015 added the identity seam: an optional `IdentityResolver` service
`(clientGroupId) → Effect<identity>` that `SyncServer` consults to populate
`SyncContext.identity` on every push and pull (and, since ADR-0025, read). It
said a carrier "derives identity from its authenticated connection (a verified
token) and provides the resolver", but the resolver never saw the connection:
it got the client group id and nothing else. The client group id is
client-chosen (a plain, non-`httpOnly` cookie, ADR-0020), so a resolver could
only map it to a user through a binding the app's sign-in wrote out of band,
as `examples/commerce` does with its `client_groups` table. A resolver that
verifies a session cookie or an API key on the request itself had nothing to
verify.

The owner's decision on #219 (2026-11-11, option b): widen the core seam so the
resolver receives the request's credentials, and thread the request through
the push, pull and read handlers. A later package resolves identities with
effect-auth (session cookie and API key credential planes) and fails closed to
anonymous; core gives it what it needs and nothing more.

## Decision

- **`Authorization.RequestCredentials`** (root entry): an opaque, read-only view
  of the transport request's credential-bearing headers, with one accessor,
  `header(name): Option<string>`, looked up case-insensitively. Names are
  lowercased once, at construction; a repeated header keeps every part, joined
  as HTTP joins a repeated field (`; ` for `cookie`, `, ` otherwise). It offers
  no way to list its headers, keeps its values in a closure, and prints as
  `RequestCredentials(<redacted>)`. `Authorization.credentialsFromHeaders(headers)`
  builds one from a WHATWG `Headers` (or any iterable of `[name, value]` pairs)
  or a plain record (such as `effect/http`'s `Headers`);
  `Authorization.noCredentials` has every header absent.
- **`IdentityResolver.resolve(request: IdentityRequest)`**, where
  `IdentityRequest = { clientGroupId, credentials }`. This is the breaking
  change: a resolver written against `(clientGroupId)` moves to
  `({ clientGroupId })`. Failure semantics are unchanged: a failing `resolve`
  fails the request with its `AuthorizationError`. A resolver that fails closed
  to anonymous returns its anonymous identity rather than failing.
- **Credentials never reach `SyncContext`.** `SyncContext` is unchanged
  (`clientGroupId` and the resolved `identity`); middleware, auth filters,
  named-set resolvers, mutators, logs, spans and errors see only that. The
  resolver alone sees the credentials, and must not copy a raw credential into
  the identity it returns or into an error message, which reaches the client.
- **Carriers pass the credentials.** `Transport.ServerHandler`'s `handlePush`,
  `handlePull` and `handleRead` take an optional second argument,
  `HandleOptions = { credentials?: Option<RequestCredentials> }`; absent or
  `None` means `noCredentials`. A carrier that has a transport request passes
  its headers:
  - `RpcTransport.layerHandlers` passes the headers `effect/rpc` hands each
    call: the HTTP request's (`layerProtocolHttp`) or the WebSocket upgrade
    request's (`layerProtocolWebsocket`), merged with the headers the RPC client
    attached to the call, which win on a clash. Those are as client-asserted as
    any credential; a resolver verifies them and never trusts a header an
    upstream proxy sets to vouch for a user.
  - The Cloudflare room (`Room.make`) passes the room request's headers, which
    `Worker.routeSync` forwards unchanged and `BindingTransport` carries the
    document request's cookie into.
  - The in-process paths take them from the request they act for:
    `Hydration.snapshot({ credentials })`, `Server.mutate({ credentials })` and
    `Transport.makeInMemory(handler, group, { credentials })`; the SvelteKit
    helpers `loadSnapshot` and `runFormMutation` take
    `credentials: requestCredentials(event)`.
- **No request, no credentials.** The in-memory loopback and any call without
  options present `noCredentials`; so do tests.
- `pokes(clientGroupId)` is unchanged: a poke stream carries no data and runs
  no resolver.

## Consequences

- A resolver can verify the request itself (a signed session cookie, an API
  key), so an app no longer needs a client-group binding table to give the
  sync tier an identity. A binding stays a valid resolver; the commerce example
  keeps one, because its sync process does not run the auth library that
  verifies its session cookie.
- `ServerHandler` callers keep compiling (the options are optional), but a
  carrier that does not pass them makes every request anonymous to a
  credential-reading resolver. Every in-repo carrier with a request passes them.
- Credentials are per request. A WebSocket carrier presents the upgrade
  request's headers for every call on that socket, so a session revoked mid-
  connection is seen only if the resolver checks revocation on each call.
- The breaking change is a `minor` of `@thomasfosterau/legation` (pre-1.0), in
  its own PR.
