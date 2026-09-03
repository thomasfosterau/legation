# ADR-0025: Server-fallthrough reads

Date: 2026-07-03
Status: Accepted (design note for ADR-0022 program step 6; landed in #96). Coverage rule superseded by ADR-0029

## Context

ADR-0022's Client promises that **where a read is answered is
configuration, never a concept the UI sees**: replica (covered by active
subscriptions), host (engine elsewhere, reads cross the channel), or —
the missing third tier — **server**: "the plan is not covered locally:
the read falls through to the server (evaluated under the same auth
filters, point-in-time, no CVR registration). `observe` upgrades a
fallthrough into a subscription." Deferred to this note: what the wire
operation is, what "covered" means, what happens to the fetched rows, and
what the read is allowed to _not_ see.

The protocol today has two verbs, push and pull. Pull is not a read: it
is a CVR diff against a registered subscription set, priced for
continuity (cookie, next-view bookkeeping, patch assembly). A one-shot
read over windows the client never intends to keep must not pay that —
and must not pollute the CVR it isn't part of.

## Decision

### The wire operation: `read`

A third protocol operation beside push/pull: a **point-in-time batch
subset evaluation**.

```
ReadRequest  = { clientGroupId, subsets: Subset[], schemaVersion? }
ReadResponse = { rows: { collection, id, version, value }[] }
```

Server-side it is pull's front half with the continuity stripped out: the
same identity resolution, the same middleware seam (a new optional
`onRead` hook, passthrough by default), the same deny-by-default auth
filters AND-ed into every subset — then `Backend.evaluate` + `getRows`,
and nothing else. **No cookie, no CVR read or write, no
`lastMutationIds`.** A fallthrough read can never perturb sync state; the
worst it can be is stale, and pull remains the only correctness path.

`ClientTransport.read` and `ServerHandler.handleRead` carry it. The
member is **optional on the transport**: carriers that predate it (or
deliberately omit it) simply don't offer the third tier, and the Client
degrades to answering locally — transparency also means the app never
has to handle "tier unavailable".

### The rows do not enter the replica

The replica is **subscription-defined**: every local row is in some
registered window's CVR view, kept alive by pull diffs. Fallthrough rows
are in no window — writing them into the store would strand them (the
next pull's diff doesn't know them and can't retire them). So `read`
results go to the caller and nowhere else. If the caller wants the rows
to live, that is precisely a subscription: `observe` **is** the upgrade
path (observing registers the windows — ADR-0022's ledger — and the
replica hydrates through the ordinary pull). `Client.query` falls
through; `Client.observe` never does.

### Coverage is the Client's own ledger

`Client.query` answers locally when the read's root window is registered
in this Client's interest ledger (observers + explicit pins, by subset
hash) — the set of windows the app has actually declared live. Otherwise
it falls through. The check is deliberately **exact**: no subsumption
("a whole-collection subscription covers any filtered subset of it" is
true but left as a future refinement), no cross-Client knowledge. A
false negative costs one server round trip and returns an equally
correct — in one respect _more_ correct — answer.

> **Coverage superseded by ADR-0029.** The exact hash match above is
> replaced by conjunct subsumption with strict windows: a subscription on
> the same collection covers a read when its top-level conjuncts are a
> subset of the read's, and its window is absent or a prefix of the same
> order from the same cursor. ADR-0029 §3 states the rule; #162 implements
> it for the mirror, the owned engine and the JSON:API façade alike.

### Includes resolve in two phases

A fallthrough read with `include` compiles exactly like a local one
(`Query.plan`), then evaluates in at most two round trips: the root
subset first; then, derived from the returned parents, the edge subsets
in one batch — `id IN (…)` for `one` edges, `fk IN (parents)` for `many`,
and the per-parent `(fk = parent, order, limit)` windows of ADR-0024 for
paginated edges. The join is assembled client-side with the same
field-mapping resolution and the same `Query.applyWindows` as the local
path — one semantics, two sources.

### What a fallthrough read does not see

It is **authoritative-only**: pending optimistic mutations journaled
locally are not overlaid onto server results. This is the honest reading
of the tier — an uncovered read is by definition outside the app's
declared live working set, and the authoritative answer is the useful
one there. (Overlaying the journal's local writes onto fallthrough
results is possible future work; it needs rebase-aware semantics, not a
quick merge.) Covered reads see optimistic state exactly as before.

### The hosted tier composes

Over a mirror channel the same `read` crosses as a request/response pair
(requestId-correlated, like mutations): the mirror asks, the host — which
owns the transport — performs the fallthrough and answers. A component
on a Client.connect Client gets the same three tiers with the same
semantics; the host's ledger/coverage plays no part (the mirror-side
Client decides coverage from its own ledger, the host just executes).

## Consequences

- The three-tier promise is real: `query` answers from the replica when
  covered, crosses the channel when hosted, and falls through to the
  server otherwise — the calling component cannot tell which happened.
- A new protocol operation means carriers grow a route (RPC method, HTTP
  endpoint). Optionality keeps old carriers valid; version negotiation
  (ADR-0018) is untouched because absence is a static property of the
  carrier, not a runtime surprise.
- Server cost per fallthrough is one authorized batch evaluation — no
  CVR storage churn, so casual one-shot reads don't inflate sync state.
- Auth is uniform by construction: the same `AuthPolicy` filters apply
  to subscriptions and fallthrough reads; there is no second read path
  to audit.
- Staleness semantics are explicit: point-in-time, no liveness, no
  optimistic overlay. Apps that need liveness observe (and thereby
  subscribe); apps that need optimistic visibility keep the read within
  covered windows.
