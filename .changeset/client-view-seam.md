---
"@legation/effect": minor
"@legation/svelte": minor
---

One client surface over engine and mirror (ADR-0021): core gains
`ClientView` — the narrow surface component bindings consume (query/observe,
subscribe/unsubscribe, mutate/mutateWithAck with awaited-outcome semantics) —
with `fromEngine` and a `layer` deriving it from the in-context engine.
`TabMirror` satisfies it structurally, aggregates derive over any view's
`observe` (`Aggregate.observe`/`observeGrouped`), and `Related`'s read side
takes a `ClientView.Reader`, so joins and aggregates work over mirrors
unchanged.

For `@legation/svelte`, the seam is what lets the same components run over a
main-thread engine and a service-worker-hosted mirror with zero component
changes — the Client the hooks read from context is built over either.
