---
"@thomasfosterau/effect-sync-core": minor
---

Add **named queries** (`Query`): a read defined once and resolved twice, like a
mutator. The client resolves a name + args to a `Subset` it renders locally; the
server resolves the same name + args to the _authoritative_ subset it syncs,
with the request's identity in hand — so query shaping and permission move to
the server (it can narrow, scope to a tenant, or add a filter the client can't
override) while the client still renders from the rows it was sent.

- `Query.make` + `Query.registry` (client subset factories) + `Query.resolver` /
  `Query.QueryResolver` service (server, context-aware, args-validated).
- `PullRequest` gains an optional `namedSubscriptions` field; `SyncServer`
  resolves each via the `QueryResolver`, then authorizes and evaluates it
  identically to a client-authored subscription.
- `ClientEngine` gains `subscribeQuery` / `unsubscribeQuery` / `queryNamed` /
  `observeNamed` and an optional `queries` registry. Backward compatible —
  engines without named queries are unchanged.
