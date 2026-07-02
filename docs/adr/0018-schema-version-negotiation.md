# ADR-0018: Schema-version negotiation and fleet cookie-reset

Date: 2026-07-02

Status: Accepted

## Context

ADR-0014 fixed the _policy_ for evolving a live deployment's schema:
expand/contract, realised with the engine's existing mechanics (rows carried
untouched on the read path, versions that move when an encoding changes, and an
unrecognised cookie that degrades to a reset patch). For a genuinely breaking
shape it prescribes a **schema-epoch bump carried in the cookie namespace** so
every client takes one reset patch. That ADR named the discipline but left three
runtime hooks unbuilt:

- there was no way for a client to _tell_ the server which build it is, nor for a
  server to _refuse_ a build it no longer serves — an obsolete client would push
  mutations the backend could only reject one by one;
- the epoch/cookie-namespace bump was described but not implemented — nothing on
  `SyncServer` actually tagged a cookie or invalidated a pre-epoch one;
- a client had no local "my cached shape is stale" buster for the case where the
  _client_ build changes in a way that should discard its confirmed rows.

A version refusal must also stay distinct from a per-mutation `MutationRejected`
(#35): that is a permanent, per-intent business verdict recorded against
`lastMutationId`; a version refusal is a transport-level "your build is obsolete"
that must **not** touch the journal — the intents are retained for an updated
build.

## Decision

Add the runtime **mechanism** for schema-version negotiation; the policy stays
ADR-0014.

- **Protocol carries an optional `schemaVersion`.** `PushRequest` and
  `PullRequest` gain `Schema.optional(Schema.String)`. Additive and
  wire-compatible: an old client omits it and still decodes, a new server
  tolerates its absence.

- **Server acceptor rejects up front.** `SyncServer` gains
  `acceptSchemaVersion?: (version: string | undefined) => boolean` (default:
  accept everything). When it returns `false`, `handlePush`/`handlePull` fail
  with a typed `VersionNotSupportedError` **before** applying mutations or
  computing a patch, so the journal is never poisoned. The error is raised
  outside the `TransportError` mapping, so it is distinguishable from a transport
  failure across the in-memory `ServerHandler`/`ClientTransport` seam. The RPC
  carrier's wire error schema carries only a message, so over RPC the tag is lost
  and the rejection degrades to a `TransportError` — a documented best-effort
  limitation (RpcTransport.ts).

- **Client sends its version and reacts once.** `ClientEngineOptions` gains
  `schemaVersion?` (sent on every push/pull) and `onUpdateNeeded?`. On a
  `VersionNotSupportedError`, `push`/`pull` fire `onUpdateNeeded` (and emit an
  `UpdateNeeded` engine event) **exactly once per ongoing rejection** — a latch
  dedupes a retry storm and repeated pulls, and resets when a request next
  succeeds. The pending journal is retained. The sync loop swallows the version
  error (it is neither transient nor a terminal `SyncFailure`); the app was
  already told to update.

- **Local `storeVersion` buster.** `KeyValueOptions.storeVersion?` stamps a
  persisted key; on open, a mismatch clears confirmed rows + the cookie (so the
  next pull is a full reset) and re-stamps — but **preserves the pending
  journal**. A client-side shape change discards the cache without dropping the
  user's unsynced intents.

- **Fleet cookie-reset via a CVR namespace bump.** `SyncServer` gains
  `cookieNamespace?`. Every minted cookie is tagged with it; a presented cookie
  under a _different_ namespace is treated as unknown, so its next pull degrades
  to a reset patch (`Clear` + full puts — exactly the `Cvr` unknown-cookie path).
  Bumping the namespace on deploy therefore resets the whole fleet in one place —
  the runtime realisation of ADR-0014's schema-epoch bump, and independent of CVR
  eviction (a still-present CVR under the old namespace is ignored).

## Consequences

- An obsolete build is told to update through one typed signal, instead of
  discovering it via a stream of per-mutation rejections; its journal survives, so
  it converges once updated.
- Breaking-change rollout (ADR-0014) is now a one-line `cookieNamespace` bump on
  the server plus, optionally, a `storeVersion` bump on the client — no migration
  DSL, leaning on the reset-on-unknown-cookie path that already exists.
- The version tag is advisory to the acceptor: the server decides the policy
  (accept-all, allow-list, min-version). The engine ships only the mechanism.
- Over the default RPC carrier the version error currently degrades to a
  `TransportError`, so `onUpdateNeeded` fires only over carriers that preserve the
  tag (the in-memory seam). Carrying the tag over RPC is a schema-typed error
  variant away and can layer on without changing this model.
