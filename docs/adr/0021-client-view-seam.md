# ADR-0021: One client surface over engine and mirror (ClientView)

Date: 2026-07-03
Status: Accepted

## Context

ADR-0010's recommended deployment splits the client across two hosts: the
engine in a per-origin service worker, and per-context in-memory mirrors
updated by broadcast. `Mirror` (called `TabMirror` until the seam moved to
core — the party need not be a browser tab) deliberately mirrors the shape
of `ClientEngine`
(`query`/`observe`/`subscribe`/`mutate`), but it was a distinct type — and
the framework bindings were hard-wired to `ManagedRuntime<ClientEngine>`, so
a tab in the recommended deployment could not drive `@thomasfosterau/legation-svelte` (or
React) components at all. Every app either ran the engine on the main thread
or hand-rolled its own binding layer.

Prior art: SwiftData exposes one `ModelContext` surface over main-actor and
background contexts; Replicache hides its leader/follower split behind a
single client interface.

## Decision

Core defines **`ClientView`** — the narrow surface a component binding needs:

- reads: `query` / `observe` (current rows first, live thereafter)
- subscription registration: `subscribe` / `unsubscribe`
- writes: `mutate` (resolves on journal) and `mutateWithAck` with
  **awaited-outcome semantics** (resolves with the backend's authoritative
  `MutationOutcome` — the mirror's shape; `ClientView.fromEngine` folds the
  engine's handle-based variant)

The error channel is the union of what either host can fail with
(`MutatorError | StoreError | TransportError`); each implementation's is
narrower. `Mirror` satisfies the interface **structurally**;
`ClientView.layer` derives the view from an in-context engine, composed with
`Layer.provideMerge(engineLayer)` so an engine-backed runtime exposes both.

Bindings consume `ClientView`: the Svelte runtime context becomes
`ManagedRuntime<ClientView>`. Aggregates derive over `observe`
(`Aggregate.observe`/`observeGrouped`, extracted from the engine), and
`Related`'s read-side takes a `ClientView.Reader` (`query` + `observe`), so
joins and aggregates work over mirrors unchanged.

Named queries and auto-subscribing relational reads are part of the seam
(added by the mirror-protocol extension that followed this ADR): the view
carries `subscribeQuery`/`queryNamed`/`observeNamed` and `related`. A mirror
forwards the registration to its host — `SubscribeNamed` registers the named
query with the host engine (which owns the server round-trip);
`SubscribeRelated` runs the reconcile loop AND the join host-side, and the
mirror receives resolved rows (`RelatedUpdate`), keeping data work off the
main thread. Registrations are refcounted per mirror like subset
subscriptions.
Engine-only capabilities that remain — explicit push/pull, undo — look the
full `ClientEngine` up in context.

Two asymmetries between the hosts shape the mirror side of the seam. First,
a mirror only carries keys somebody registered — unlike an engine it cannot
evaluate an arbitrary subset locally — so on a mirror **observing IS
subscribing**: `observe`/`observeNamed`/`related` register their subject
with the host for the stream's lifetime. Second, the host refcounts
registrations per MIRROR (a set): any `Unsubscribe` drops the mirror's
whole claim on that key, so the mirror keeps a per-key interest ledger
(observer count + explicit pin) and speaks with one voice — `Subscribe` on first
interest, `Unsubscribe` only when the last observer ends and no explicit
`subscribe` pins the key. The ledger doubles as the replay set for
`HostReady`, the announcement a starting host broadcasts so registrations
survive service-worker restarts and mirrors that raced the worker's boot.

## Consequences

- The same components run over a main-thread engine and a SW-hosted mirror
  with zero component changes — verified by a binding test whose runtime
  holds only a `Mirror`.
- Breaking for `@thomasfosterau/legation-svelte` (0.x): engine-backed apps compose
  `ClientView.layer.pipe(Layer.provideMerge(engineLayer))` when building the
  runtime.
- The named-query and auto-subscribe gaps over mirrors are closed: the
  mirror protocol carries `SubscribeNamed`/`SubscribeRelated` (host-resolved,
  the mirror receives resolved rows), so the full binding surface works in the
  SW-hosted deployment.
- The React binding still consumes `ClientEngine` via its atoms; migrating it
  to the seam is follow-up work.

## Amendment (#146, #136, #147): one generic host-request envelope

Date: 2026-11-11
Status: Proposed. It specifies the owner's decision of 2026-10-23 (#146, #136,
#147), and is accepted when its PR merges.

**Context.** Two features need a mirror to ask its host for something that
is not part of the `ClientView` surface. #146: a tab holds a server-rendered
snapshot (ADR-0020) and the host owns the store it must hydrate. #136:
devtools in a tab must read the host engine's journal, subscriptions, cookie,
collections and sync failures, and follow its event stream. The owner decided
that the mirror protocol gains **one** generic request/response envelope with
a typed request kind, and that hydration and the introspection reads are its
kinds. Two dedicated extensions, and hydrating only on the host side with
nothing crossing the mirror, are not taken. The mirror-aware boot unit is
#147's `createClient` handle.

**Decision.**

1. **Messages.** Three new messages; nothing existing changes.
   - Mirror → host: `HostRequest { mirrorId, requestId, kind, payload }`,
     where `kind` is a string naming a request kind and `payload` is that
     kind's encoded request. `requestId` is unique per mirror, as for `Mutate`
     and `Read`.
   - Mirror → host: `HostRequestCancel { mirrorId, requestId }`, which ends a
     streaming request. It is idempotent: cancelling a finished or unknown
     request does nothing.
   - Host → mirror: `HostResponse { mirrorId, requestId, outcome }`, where
     `outcome` is one of:
     - `{ _tag: "Value", value }`: a single-reply kind's answer, which ends the
       request;
     - `{ _tag: "Item", value }`: one element of a streaming kind's answer;
       more follow;
     - `{ _tag: "End" }`: a streaming kind's answer is complete;
     - `{ _tag: "Failure", reason, message }`, which ends the request, with
       `reason` one of `"UnknownKind"`, `"InvalidRequest"` or `"Failed"`.

     Replies echo `mirrorId`, and a mirror ignores a reply addressed to
     another, as #546 does for `Mutate` and `Read`.
2. **Kinds are declared once, in core.** A kind is a value with a name, a
   request schema, a response schema, and whether it streams. Both sides
   encode and decode through the kind's schemas, so the payload is typed at
   each end and `unknown` only on the wire. The host keeps a registry of the
   kinds it serves. Kinds outside core (a devtools-only kind, say) register
   the same way, under a name prefixed with their package, so no two
   packages claim one name.
3. **Errors.** Every failure is a reply, never a dropped message:
   - a kind the host does not serve: `UnknownKind`;
   - a payload that does not decode against the kind's request schema:
     `InvalidRequest`;
   - a handler that fails or dies: `Failed`, with its message.

   The mirror surfaces each as a typed `HostRequestError` with the reason.

4. **Versioning.**
   - **A host that predates the envelope** decodes `HostRequest` as foreign
     traffic and ignores it. So every request carries a timeout on the mirror
     side, and a timeout fails with `HostRequestError` reason
     `"Unanswered"`, which a caller reads as "this host does not serve the
     envelope". A mirror never waits forever.
   - **A host restart** (`HostReady`) fails every request the mirror has in
     flight with `"Unanswered"`. A streaming request is not replayed: its
     caller re-requests, since the stream it was following ended with the old
     host.
   - **A mirror that predates the envelope** never sends one, so nothing
     changes for it.
   - **A new kind** is additive: an older host answers it `UnknownKind`.
5. **Lifecycle.** Requests are scoped on the mirror. Interrupting the caller
   of a streaming request sends `HostRequestCancel`, and the host interrupts
   the handler's stream. A mirror's `Disconnect`, or its liveness sweep,
   cancels every request it holds, as it releases its subscriptions.
6. **Hydration (#146) is the kind `hydrate`**, single-reply.
   - **Request:** a `Hydration.Snapshot`.
   - **Response:** `{ hydrated: boolean, reason?: "NotEmpty" | "AlreadyPulling" }`.
   - **The host owns the empty-store gate.** Under the engine's pull
     serialisation, it hydrates iff the store is empty (`Hydration.isEmpty`:
     no cookie, no rows, no journalled or unpulled mutations) and no pull has
     started since the engine booted. A started pull is about to fill the
     store, and the snapshot's cookie would race it.
   - **Concurrent tabs and late snapshots.** The first snapshot to reach an
     empty host wins. Every later one, from another tab or after a pull, is
     answered `hydrated: false` with its reason. It is never an error, and it
     never touches the store: the host's replica is then at least as fresh as
     the late snapshot.
   - **The tab.** Once the reply arrives, the tab renders from the host as
     usual; a `false` reply needs no action. Until then it renders from the
     snapshot locally, which is what makes first paint flash-free.
   - After a hydration, the engine re-syncs attached views as
     `Hydration.hydrate` already does, and the first pull continues from the
     snapshot's cookie (ADR-0020).
7. **Introspection (#136)** is these kinds, each typed by the
   `EngineIntrospection` member it serves:
   - single-reply: `introspect/subscriptions`, `introspect/journal`,
     `introspect/cookie`, `introspect/collections` and
     `introspect/syncFailures`;
   - streaming: `introspect/events`.

   Mutation states keep their existing `SubscribeMutationStates` messages
   (#116), which `ClientView` already uses: one path for one stream.
   `Introspection.fromMirror` builds an `EngineIntrospection` over these, so
   the devtools core attaches to an owned engine and a mirror with the same
   `DevtoolsCore` shape.

**Consequences.**

- The mirror protocol has one extension point for host requests. A future
  host-side capability adds a kind, not a message, and an older peer answers
  or ignores it predictably.
- `MirrorProtocol` gains three message cases and the kind registry.
  `MirrorChannel` and `EngineHost` gain the request routing and the
  per-mirror request table.
- #146 implements `hydrate`, the `createClient` mirror boot and commerce's
  snapshot path. #136 implements the introspection kinds and
  `Introspection.fromMirror`. Neither needs another protocol change.
