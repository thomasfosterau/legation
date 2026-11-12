# @thomasfosterau/legation-auth

[effect-auth](https://www.npmjs.com/package/@thomasfosterau/effect-auth) for the
[`@thomasfosterau/legation`](../effect) sync engine: who a push, pull or read
comes from, which rows they may read, and what happens to the device's replica
when they sign out.

> **Private for now.** This package is not yet published to npm.

- **`Resolver`** — an `Authorization.IdentityResolver` that verifies the
  request's session cookie, `Authorization: Bearer` session token or API key
  with effect-auth on **every** push, pull and read, and puts a typed
  `Principal` on `SyncContext.identity`. It **fails closed**: anything that
  does not verify, and any fault or defect, is the anonymous principal.
- **`ReadScopes`** — effect-auth's compiled read scopes (`ReadScope.compile`)
  as legation auth filters. The translation is exact; whatever cannot be
  translated exactly **narrows to `Deny`**, never widens.
- **`SignOut`** (on `@thomasfosterau/legation-auth/client`) — the session-change
  listener that resets the durable replica when the signed-in user changes,
  quarantining their unpushed writes.

## Install

```sh
npm install @thomasfosterau/legation-auth @thomasfosterau/legation \
  @thomasfosterau/effect-auth effect
```

Peers: `@thomasfosterau/effect-auth ^0.2.0` and `effect ^4.1.0` (effect-auth
0.2 requires Effect 4.1). ESM only. Tested against `effect` 4.1.0 (the floor)
and the workspace pin.

## Identity: `Resolver`

```ts
import * as Layer from "effect/Layer";
import { Resolver } from "@thomasfosterau/legation-auth";

// Needs effect-auth's SessionService and ApiKeyService in context.
const identity = Resolver.layer();
// Session plane only (an API key resolves to anonymous):
const sessionsOnly = Resolver.layerSessions();
```

Provide it beside the sync server; every carrier that has a transport request
passes its headers to the resolver (ADR-0035). The resolver reads only the
`cookie`, `authorization` and API-key headers, by name.

- **Session plane**: the session token from `Authorization: Bearer <token>` /
  `Token <token>`, else from the session cookie, validated with
  `SessionService.validateSession` → `Principal.Session` (`userId`, `user`,
  `sessionAttributes`, `expiresAt`).
- **API-key plane**: the key from the API-key header (default `x-api-key`),
  verified with `ApiKeyService.verify` → `Principal.ApiKey` (`userId`, `keyId`,
  `permissions`). A request carrying an API-key header is decided by this plane
  alone: a key that does not verify makes it anonymous even beside a valid
  cookie. Each verify counts against the key's remaining uses, as effect-auth's
  own `verify` does.
- **Fails closed**: no credential, an unknown, expired, revoked or disabled
  credential, a store or transport fault and a defect all resolve to
  `Principal.anonymous`. The request is never failed. Each fail-closed
  resolution logs one warning naming the plane and kind (`rejected`, `fault`,
  `defect`) — never the credential, a header value or an effect-auth message.
- A principal never carries a credential: not the session token, not the key,
  not its hash.

Options (each defaulting to effect-auth's):

```ts
Resolver.layer({
  // The naming you give effect-auth's HTTP tier, so the effective cookie name
  // (with its `__Host-` prefix) is derived identically. Default:
  // `__Host-conduit_session`.
  cookie: { name: "app_session" },
  apiKeyHeaders: ["x-api-key"],
});
```

`Resolver.make({ sessions, apiKeys }, options)` builds the resolver from the
services directly (each `Option`).

Read the principal in an auth filter, middleware or named-set resolver with
`Principal.fromContext(context)`; anything that is not a principal this
resolver produced reads as `Principal.anonymous`. `Principal.userId(p)` is the
user it acts for (`None` when anonymous).

## Read scopes: `ReadScopes`

effect-auth compiles a policy set into one principal's read scope over a
resource type: `AllowAll`, `Deny`, or `Filter { predicate, sets }`.
`ReadScopes.policy` turns a set of such resource types into legation's
`AuthPolicy`. The binding is derived from the node and the compile request
from the principal, so none of it restates the schema or the principal by
hand:

```ts
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Authorization, Predicate } from "@thomasfosterau/legation";
import { ReadScopes } from "@thomasfosterau/legation-auth";

const authPolicy = Result.gen(function* () {
  // effect-auth attribute → where it lives on the node; kinds come from the node.
  const posts = yield* ReadScopes.bindingOf(Post, {
    resourceType: "Post",
    attributes: {
      owner: { field: "ownerId", entity: "User" }, // an entity ref, bound as its id
      visibility: "visibility", // Text, from the node's schema
      publishedAt: "publishedAt", // Instant, as the node's filterable declares it
    },
    setFacts: { followsOwner: { attribute: "owner", set: "following" } },
  });
  return yield* ReadScopes.policy(
    {
      posts: {
        ...posts,
        // The users the principal follows: `followeeId` of its `follows` rows.
        sets: {
          following: ReadScopes.userSet(backend, {
            source: "follows",
            where: (userId) => Predicate.eq("followerId", userId),
            member: "followeeId",
            maxAge: "1 hour",
          }),
        },
        compile: ReadScopes.compiler({
          policies: () => Effect.succeed(policies),
          request: ReadScopes.principalRequest({ action: "read" }),
        }),
      },
    },
    { filters: { tags: Authorization.allowAll }, collections: registry }
  );
}); // Result<Authorization.AuthPolicy, ScopeMappingError>
```

- **The binding from the node.** `ReadScopes.bindingOf(node, { resourceType,
  attributes, setFacts })` gives each scalar attribute its field's literal
  kind (`FilterPolicy.kindOf` of the row schema, or the node's declared
  filterable kind, so an `instant` stored as text is an `Instant`), and an
  `{ field, entity }` attribute `{ entity }`, which must sit on a text field.
  A field the node lacks (`UnmappedAttribute`), an entity on a non-text field
  or a field whose kind cannot be derived (`FieldKind`) is a
  `ScopeMappingError` when the policy is built — never a `Deny` per request.
  It returns `{ binding, attributes }`, the two members of a scoped
  collection; hand-written ones still work.
- **The request from the principal.** `ReadScopes.principalRequest({ action,
  principalType?, entities? })` compiles for `User::<userId>` (a session's or
  an API key's) and the action (`"read"` is `Action::"read"`). The anonymous
  principal is `User::""` (`ReadScopes.principalRef`), an id no effect-auth
  user has, so a forbid scoped to `User` still binds it; a policy naming the
  principal admits it nothing (see "The anonymous principal owns nothing"
  below). The slice comes
  from effect-auth's `EntityResolver` when you pass one (`entities`); else a
  session's user sits under `Rbac.roleRef(user.attributes.role)` and carries
  that `role` attribute, so `Policy.role` and `Policy.roleAtLeast` both see it;
  an API key carries no user record and gets no role. The anonymous
  principal's slice never holds a user: no resolver is asked who `User::""`
  is. A resolver that fails narrows the filter to `Deny`.
- **Named sets from the backend.** `ReadScopes.userSet(backend, { source,
  where, member, maxAge })` is `Authorization.namedSet` keyed on
  `Principal.userId`: its members are the distinct `member` values of the
  `source` rows `where(userId)` selects. The anonymous principal (and an
  identity this package's resolver did not produce) has the empty set without
  a read; a backend failure binds the set to nothing.
- **Checked when built.** Every attribute of the binding and every set fact's
  attribute must map to a row field, the map names nothing the binding lacks,
  and every set a set fact names has a `NamedSet`. A gap is a
  `ScopeMappingError` from `ReadScopes.mapping` / `ReadScopes.policy`, not a
  per-request surprise.
- **Deny by default.** Only the listed collections (and `filters`) get a
  filter; any other collection stays unreachable.
- **The role short-circuit.** A principal effect-auth grants everything
  (`AllowAll`, e.g. an admin role) gets legation's `AllowAll`: no predicate is
  AND-ed in at all.
- **Exact translation.** effect-auth's predicate is two-valued (an absent
  attribute makes `Eq` / `Compare` / `InSet` false); legation's follows
  Postgres's three-valued logic. Each such atom becomes
  `field IS NOT NULL AND atom`, so the rows legation admits are exactly the
  rows effect-auth's `ReadScope.matches` admits — `Not(visibility = "private")`
  admits a row with no visibility in both. The one exception is the narrowing
  below.

  | effect-auth                   | legation                                                  |
  | ----------------------------- | --------------------------------------------------------- |
  | `Eq(a, v)`                    | `and(isNotNull(f), eq(f, v′))`                            |
  | `Compare(op, a, v)` (numeric) | `and(isNotNull(f), compare(op, f, v′))`                   |
  | `IsNull(a)`                   | `isNull(f)`                                               |
  | `InSet(a, set)`               | `and(isNotNull(f), inSet(f, set))` — the set by name      |
  | `And` / `Or` / `Not`          | `and` / `or` / `not`                                      |
  | `Text` / `Boolean`            | the string / boolean                                      |
  | `Integer`                     | a safe integer                                            |
  | `Double`                      | a finite number                                           |
  | `Instant(ms)`                 | `new Date(ms).toISOString()`, whole ms in years 0000–9999 |

- **The anonymous principal owns nothing.** effect-auth compiles a policy
  naming the principal (`resource.owner == principal`) for `User::""` to
  `Eq(owner, Text(""))`, which would admit every row whose owner field is the
  empty string to every signed-out viewer. For the anonymous principal (the
  request's, in `toAuthFilter`; `options.principal` in `translate`), an `Eq`
  of an entity attribute against `""` in a positive position (under an even
  number of `Not`s) translates to false. Under a `Not` it is kept: false
  there would widen, and as it is it already admits no empty owner. So a
  signed-out viewer never reads a row through an ownership rule, a
  signed-in principal's scope is exact, and public rows are unaffected. This
  only ever narrows effect-auth's `matches`, and only on rows whose entity
  field is `""` (`corpus-oracle.test.ts` asserts that is the whole
  disagreement).
- **Narrow, never widen.** An `Inexact` compilation, a node with no exact
  translation (a `Compare` on text or booleans, which effect-auth's `matches`
  never holds), a literal of another kind than its attribute or outside its
  domain, and a compile that fails or dies are a `ScopeMappingError`, and the
  filter answers `Deny` for the whole scope — never a dropped conjunct, never
  `AllowAll`. It logs one warning with the collection and the reason, never the
  identity or a credential.
- **Named sets.** The translated predicate names each set (`Predicate.inSet`),
  so a subscription's authored scope is the same pull after pull while the
  set's members move. A set that fails to resolve, or that the scope names but
  the mapping does not declare, binds to nothing: that branch admits no row.

`ReadScopes.translate(scope, mapping, { principal? })`, `ReadScopes.translateCompiled` and
`ReadScopes.literal` are the pure translation, as `Result`s;
`ReadScopes.toAuthFilter(compile, mapping)` is one collection's filter.

## Sign-out: `SignOut` (`/client`)

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createAuthClient } from "@thomasfosterau/effect-auth/client";
import { Client } from "@thomasfosterau/legation";
import { SignOut } from "@thomasfosterau/legation-auth/client";
import * as Digest from "effect/crypto/Digest";

const auth = createAuthClient({ baseUrl: "/api/auth" });

const program = Effect.gen(function* () {
  // Boot under the session you know (e.g. `await auth.getSession()`):
  const session = Option.fromNullishOr(yield* Effect.promise(() => auth.getSession()));
  const { client } = yield* Client.make({
    // ...nodes, mutations, store, transport
    identity: yield* SignOut.fingerprintOfSession(session),
  });
  // From here on every session change on the store resets the replica as needed.
  const following = yield* SignOut.follow(client, auth.session);
  // After a sign-out, wait for the reset before the next viewer sees the app:
  yield* Effect.promise(() => auth.signOut());
  yield* following.settled;
}).pipe(Effect.scoped, Effect.provide(Digest.layerWebCrypto));
```

`SignOut.follow(client, store)` subscribes to effect-auth's client session
store (`createAuthClient(...).session`) for the life of the scope. Every
settled state the store notifies, and the one it holds when it starts, is
adopted in order with `SignOut.onSessionChange`, the previous session tracked
for you; a pending state (the store's first fetch, a refetch in flight) is
skipped, so a reload never reads as a sign-out. `following.settled` waits
until every change notified so far is adopted and returns the last outcome
(`None` before the store has settled once). It hashes with the `Digest` in
context, else with `Digest.layerWebCrypto`. An adoption that fails is logged
by its error tag and retried on the next notification.

Each adoption runs `Client.reset` with the session's fingerprint, whose rule
decides what survives: the same user is `Unchanged`; signed out → signed in
is an `Upgrade` (the warm replica and its journal stay); a sign-out or an
account switch is a `Reset` — confirmed rows, the pull cookie and every
subscription are dropped. The rule compares with the replica's own stamp, not
with the previous session, so a missed notification cannot skip a reset.
`SignOut.onSessionChange(client)` is the listener itself, `(previous, next)`
with each an `Option` of a session with `user.id`, for a source other than
effect-auth's store.

**Pending writes are quarantined.** On a reset, unpushed writes are not flushed
(they would be pushed under whatever credentials the transport now carries)
and not discarded (they are the user's data): they are held under the
superseded user's fingerprint, pushable again if that user signs back in
(`Client.quarantines` / `discardQuarantine` manage them). To send them, push
before signing out.

`SignOut.fingerprintOfSession(session)` is the boot stamp for
`Client.make({ identity })`: `Identity.anonymous` for `None`, else the user's
fingerprint. Boot under a session you know: a still-pending store's empty
session would reset a signed-in user's warm replica.
`SignOut.fingerprintOf(userId)` is the default fingerprint:
`legation-auth:sha256:` and the SHA-256 of the user id under a domain
separator — never the id itself. These need effect's `Digest` service
(`Digest.layerWebCrypto`, which needs `crypto.subtle`: a secure context in a
browser). Pass `{ fingerprint: f }` to use your own. The `/client` entry
imports nothing of effect-auth (its store is read by shape,
`SignOut.SessionStore`), so it is safe in a browser or service worker.

## License

MIT
