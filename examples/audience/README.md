# legation · effect-auth · JSON:API — Audience

A **headless** app that wires the whole authorization chain end to end and
proves it on replica contents:

```
effect-auth session (cookie)
  → @thomasfosterau/legation-auth Resolver (IdentityResolver, fails closed)
  → SyncContext.identity (a typed Principal)
  → effect-auth policy compiled to a read scope (ReadScopes, exact or Deny)
  → auth filter AND-ed into every subscription
  → CVR diff → patch → the device's durable replica
  → JSON:API façade over effect-jsonapi resources (JsonApiFacade)
```

One node, `posts`, with an **owner** and a three-state **visibility**
(`public | followers | private`). Who may read what is written once, as
effect-auth policies (`src/policy.ts`): public posts; one's own; followers-only
posts of people one follows (a **named set**, `following`, resolved from the
server-side `follows` collection — the relationship-scoped case of ADR-0015);
and the **moderator** role, which compiles to `AllowAll` and short-circuits.
An anonymous viewer is `User::""`, which only the public rule admits.

There is no UI: the server, the client and the façade run in one process, as
the commerce example's tests do. A browser profile is a `Device`
(`src/device.ts`): a durable `ClientStore` over a `KeyValueStore`, a cookie
jar, a network that can go down, one `Client`, and the façade.

## Layout

```
src/domain.ts   the node, the mutations, the reads (ADR-0022)
src/policy.ts   the binding (derived from the node) + policies, the `following`
                set, the AuthPolicy
src/api.ts      the effect-jsonapi resource and HttpApi (the node graph's codec)
src/server.ts   effect-auth SessionService over its testing memory stores,
                legation-auth's Resolver, Server + MemoryBackend, RestHandlers
src/device.ts   one browser profile: replica, cookie jar, transport, Client,
                SignOut.follow, JsonApiFacade
tests/          the five tests of #221
```

Users are effect-auth's own fixtures (`fixtureUser` from
`@thomasfosterau/effect-auth/testing`), its `SessionService` runs over the
`memorySessionStore` / `memoryUserStore` reference stores, and sign-in is
`createSession` (what effect-auth's HTTP tier runs after a password check):
no auth deployment.

## Tests

The tests are in the root Vitest project `auth` (effect-auth's `effect`
floor is 4.1.0), so `vp run test` and `vp run test:coverage` run them; alone:

```sh
vp test run --project auth examples/audience
```

| #   | File                          | What it asserts                                                                                                                                                                                                                                                                   |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tests/replicas.test.ts`      | Owner, follower, stranger, moderator and anonymous subscribe to the same collection; each durable replica holds exactly the rows its policy admits.                                                                                                                               |
| 2   | `tests/policy-corpus.test.ts` | A property test over 6 seeded corpora (40 posts, 6 users, a random follow graph): every viewer's replica, through the real server, equals the rows effect-auth's `ReadScope.matches` and `Policy.decidePure` admit row by row — before and after the follow graph moves.          |
| 3   | `tests/same-url.test.ts`      | For each signed-in viewer, the façade's answer from the replica and the derived REST handler's answer under the viewer's cookie are the same document, byte for byte; a row the viewer may not read is forwarded and the server answers 404.                                      |
| 4   | `tests/sign-out.test.ts`      | A signs out, B signs in on the same device: B cannot read A's rows before or after B's first pull, nor through the façade; A's unpushed draft is quarantined (#212), never pushed under B, and A's again when A signs back in.                                                    |
| 5   | `tests/offline.test.ts`       | Offline, the replica answers what it answered online and no more; an uncovered façade read is the `503`, never a partial document; server writes made meanwhile do not leak in; back online one pull narrows to the current policy; signing out offline still clears the replica. |

`pnpm run typecheck` (part of `vp run check:examples`) type-checks the app and
its tests against the packages' built `dist/`.

## Hand-written glue

The app aims to write nothing between the libraries. What it still writes by
hand, each marked in the source, is a gap a library should close:

- `device.ts` `jarTransport`: an in-process transport whose credentials follow
  the session (and whose network can go down).
- `device.ts` `makeJar`: the cookie jar, shaped as effect-auth's client
  session store, which `SignOut.follow` subscribes to (the example has no auth
  HTTP tier for `createAuthClient` to talk to).
- `server.ts` `authLayer`: effect-auth's `SessionService` over its testing
  stores.
