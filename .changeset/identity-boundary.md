---
"@thomasfosterau/legation-effect": minor
"@thomasfosterau/legation-browser": minor
---

Scope the durable replica to a resolved identity (#212), closing the gap where
adopting legation would make a multi-tenant app on a shared device _less_ safe
than what it replaced. The invariant, now in `CONTEXT.md` beside the HTTP-cache
section: **a durable replica belongs to exactly one resolved identity, and an
identity change is a reset, not a rebase.**

Identity is resolved server-side per pull, which is what makes the auth filter
trustworthy — but the replica the authorised rows land in outlives the session
that authorised them. A signs out, B signs in, and B's Client boots onto A's
rows because they are the freshest thing on the device and nothing recorded
which identity authorised them. A's unpushed journal made it worse: durable,
causally ordered, and about to go out under B's cookies.

- **`Identity` (`@thomasfosterau/legation-effect`, new)**: `Fingerprint`, the opaque
  app-supplied token a replica is stamped with — a session-subject hash, **never
  PII and never a credential**, as the type's own docs say. `anonymous` is the
  signed-out principal; `unstamped` is a replica that has never been scoped, and
  equals nothing. `transitionOf` is the whole rule, in one place so boot and
  runtime cannot disagree: `Unchanged`, `Upgrade` (anonymous → signed in, the
  one benign transition), or `Reset`.

- **`ClientStore` identity boundary**: a new `identity` option stamps the
  fingerprint and compares it on open. A mismatch quarantines the unpushed
  journal under the **superseded** fingerprint, then drops confirmed rows and
  the pull cookie. New surface: `getIdentity` / `setIdentity`,
  `quarantinePending` / `quarantinedMutations` / `quarantines` /
  `releaseQuarantine` / `discardQuarantine`, and `clearCookie`. A boundary that
  cannot be established **seals** the store — every operation fails loudly,
  nothing is served, nothing is destroyed, and the next open retries — rather
  than reporting a boundary that isn't there.

- **Quarantine is its own keyspace**, which is the security property rather than
  an implementation detail: `pendingMutations` reads the journal and `push`
  reads `pendingMutations`, so a quarantined entry is structurally unreachable
  from any push path — a background flush included — under any identity but the
  one it is keyed by. Mutation ids are preserved rather than renumbered, so an
  entry that was in flight at reset is at worst acknowledged and skipped by the
  backend's exactly-once ledger, never applied twice. Only
  `discardQuarantine` destroys one: no reset and no boot does.

- **`Client.reset(fingerprint)`** applies the same rule at runtime, dropping the
  Client's window ledger along with the rows so coverage cannot answer the new
  principal from the old replica. `Client.make` takes an `identity` and adopts
  it before the sync loop starts. `identity`, `quarantines`,
  `quarantinedMutations` and `discardQuarantine` round out the surface; a
  Client built with `connect` says the host owns the replica rather than faking
  a reset.

- **The sync client id is scoped to the principal** while the boundary is on
  (derived from the configured `clientId` plus the fingerprint). Mutation ids
  are a per-client sequence the backend requires to be contiguous, so a second
  principal continuing the first's numbering would push a gap and restarting it
  would collide with ids already applied; scoping gives each principal its own
  sequence, and gives a returning one back exactly the sequence they left.

- **`IndexedDbClientStore` (`@thomasfosterau/legation-browser`)** takes an `identity`, and
  `layerNamespaced` offers the per-identity replica as the alternative to
  resetting — namespace for a device with a few regular users who switch back
  and forth, reset where sign-ins are one-off or unbounded.

Opt-in: with no `identity` configured, nothing is stamped, nothing is compared,
and behaviour is unchanged. Turning it on resets an unstamped replica once,
which is the safe direction — an unstamped replica is exactly the state this
boundary exists to distrust.
