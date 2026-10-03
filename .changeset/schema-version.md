---
"@thomasfosterau/legation-effect": minor
---

Schema-version negotiation and fleet cookie-reset (#48) — the runtime mechanism
for ADR-0014's schema-evolution policy (ADR-0018). ADR-0014 stays the policy;
this ships the hooks.

- **Protocol.** `PushRequest`/`PullRequest` gain an optional `schemaVersion`.
  Additive and wire-compatible: an old client omits it and still decodes, a new
  server tolerates its absence.
- **Server acceptor.** `SyncServer.makeWith` / `layerWith` take
  `acceptSchemaVersion?`; a rejected version fails `handlePush`/`handlePull` up
  front with a typed `VersionNotSupportedError` — before any mutation is applied
  or patch computed, so the journal is never poisoned. Distinct from a
  `TransportError` across the in-memory transport seam (the RPC carrier degrades
  it to a `TransportError`, noted).
- **Client hook.** `ClientEngineOptions` gain `schemaVersion?` (sent on every
  push/pull) and `onUpdateNeeded?`, fired exactly once per ongoing rejection (a
  latch that resets on the next successful request), alongside an `UpdateNeeded`
  engine event. Pending mutations are retained across a rejection.
- **Local `storeVersion` buster.** `KeyValueOptions.storeVersion?` clears
  confirmed rows + the cookie on a mismatch (so the next pull rehydrates fully)
  while preserving the pending journal.
- **Fleet reset.** `SyncServer` takes `cookieNamespace?`; bumping it on deploy
  makes every previously-issued cookie unknown, so each client's next pull is a
  reset patch (`Clear` + full puts) — one place to reset the fleet.
