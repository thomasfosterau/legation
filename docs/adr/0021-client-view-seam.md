# ADR-0021: One client surface over engine and mirror (ClientView)

Date: 2026-07-03
Status: Accepted

## Context

ADR-0010's recommended deployment splits the client across two hosts: the
engine in a per-origin service worker, and per-tab in-memory mirrors updated
by broadcast. `TabMirror` deliberately mirrors the shape of `ClientEngine`
(`query`/`observe`/`subscribe`/`mutate`), but it was a distinct type — and
the framework bindings were hard-wired to `ManagedRuntime<ClientEngine>`, so
a tab in the recommended deployment could not drive `@legation/svelte` (or
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
narrower. `TabMirror` satisfies the interface **structurally**;
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
tab receives resolved rows (`RelatedUpdate`), keeping data work off the main
thread. Registrations are refcounted per tab like subset subscriptions.
Engine-only capabilities that remain — explicit push/pull, undo — look the
full `ClientEngine` up in context.

## Consequences

- The same components run over a main-thread engine and a SW-hosted mirror
  with zero component changes — verified by a binding test whose runtime
  holds only a `TabMirror`.
- Breaking for `@legation/svelte` (0.x): engine-backed apps compose
  `ClientView.layer.pipe(Layer.provideMerge(engineLayer))` when building the
  runtime.
- The named-query and auto-subscribe gaps over mirrors are closed: the
  mirror protocol carries `SubscribeNamed`/`SubscribeRelated` (host-resolved,
  tab receives resolved rows), so the full binding surface works in the
  SW-hosted deployment.
- The React binding still consumes `ClientEngine` via its atoms; migrating it
  to the seam is follow-up work.
