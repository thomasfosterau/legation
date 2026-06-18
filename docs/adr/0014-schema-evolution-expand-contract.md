# ADR-0014: Schema evolution by expand/contract with cookie-reset backfill

Date: 2026-06-18
Status: Accepted

## Context

A long-lived sync deployment must evolve collection schemas while old clients are still connected (and while offline clients hold stale rows and a durable journal). Zero documents downtime-free schema changes via ordered deploys (expand: DB → API → client; contract: client → API → DB) with automatic backfill ([schema](https://zero.rocicorp.dev/docs/schema)). The Zero feature-parity audit (2026-06-18) flagged the absence of an equivalent story here as a gap.

Three facts about this engine shape the answer:

- **The engine stores rows in their encoded form and does not decode them through the collection `Schema` on the read path.** `ClientStore` persists the raw encoded value; `ClientEngine` materializes and queries it without a schema decode (the schema is the app's tool for its own boundaries, plus wire/persistence encoding). So an extra field on a row is carried through untouched — additive change is tolerated by construction.
- **Row versions are opaque and change whenever a row's authoritative encoding changes** (a backend counter, or the JSON:API backend's content hash). A backfill that rewrites rows therefore moves their versions, and CVR diffing re-sends them as ordinary `Put` patches — there is no separate migration channel.
- **An unrecognized cookie degrades to a reset patch** (`Clear` + full `Put`s), and CVR storage may be ephemeral (ADR-0008). Forcing every client to re-materialize from scratch costs only one full pull.

## Decision

Adopt **expand/contract** as the schema-evolution discipline, realized with the mechanics above rather than a bespoke migration system.

- **Expand (additive)** — add an optional field or a new collection. Deploy order: **backend → app code → clients**. Existing clients store and round-trip the new field without understanding it (no decode on the read path); new clients read it once their code ships. Wire messages stay valid because `Schema.Struct` drops unknown members on decode. No reset required.
- **Contract (removal)** — stop reading a field/collection on **clients first**, then remove it from the **backend**. Removing a field changes affected rows' encodings, so their versions move and the next pull patches them; no reset required for field removal.
- **Breaking change (rename, type change, id reshaping)** — model it as an expand of the new shape plus a contract of the old, never an in-place mutation. When a shape genuinely cannot be tolerated by deployed clients, **bump a schema epoch** carried in the cookie namespace: the server treats every pre-epoch cookie as unrecognized, so each client takes one reset patch and re-materializes in the new shape. This is the engine's backfill — cheap because CVR storage is disposable.

The collection row codec should stay tolerant of unknown members (the JSON:API rows already use a permissive record codec), so additive changes never fail validation in flight.

## Consequences

- The common cases (new optional field, new collection) need no coordination beyond deploy order, and offline clients converge on reconnect: their journal replays against whatever shape the backend now serves, and rebase handles the rest.
- There is no migration DSL or version table to maintain; "migration" is ordered deploys plus, for breaking changes, a one-line epoch bump that leans on the existing reset-on-unknown-cookie path.
- The cost is discipline: breaking changes must be expressed as expand-then-contract, and a careless field removal that clients still read will surface as missing data until their code ships — the ordering exists to prevent exactly that.
- Backfill granularity is all-or-nothing per client (a full reset), not row-level. For very large per-client working sets a future, finer backfill (re-pull only affected collections) can layer on without changing this model.
