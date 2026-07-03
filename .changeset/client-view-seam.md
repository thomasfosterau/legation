---
"@legation/effect": minor
"@legation/svelte": minor
"@legation/sveltekit": patch
---

One client surface over engine and mirror (ADR-0021): core gains
`ClientView` — the narrow surface component bindings consume (query/observe,
subscribe/unsubscribe, mutate/mutateWithAck with awaited-outcome semantics) —
with `fromEngine` and a `layer` deriving it from the in-context engine.
`TabMirror` satisfies it structurally, aggregates derive over any view's
`observe` (`Aggregate.observe`/`observeGrouped`), and `Related`'s read side
takes a `ClientView.Reader`, so joins and aggregates work over mirrors
unchanged.

Breaking for `@legation/svelte` (0.x): `EffectSyncRuntime` is now
`ManagedRuntime<ClientView>` — engine-backed apps compose
`ClientView.layer.pipe(Layer.provideMerge(engineLayer))`. The same components
now run over a main-thread engine and a service-worker-hosted mirror with
zero component changes; engine-only helpers (`namedQuery`, auto-subscribing
`useRelated`) fail with an actionable message over a mirror-only runtime.
`@legation/sveltekit`'s `engineRuntime` provides both the view and the engine.
