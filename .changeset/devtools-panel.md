---
"@legation/devtools": minor
---

Ship `@legation/devtools` (#120): a devtools panel over the introspection
substrate — journal & mutation timeline, subscriptions & collections (with
row counts and the pull cookie), a sync activity log, and actions (force
pull/push, a simulated-offline toggle, drop a subscription, and a destructive
clear-store behind a confirm).

Architecture: a framework-agnostic headless core built entirely over
already-public substrate (`Introspection`, `ClientEngine.mutationStates`,
`engineEvents`/`syncFailures`, `ClientStore`), with thin per-framework panels
— `@legation/devtools/react` and `@legation/devtools/svelte` — as separate,
lazily-loadable entry points so an app that never imports them pays nothing
for the panel in production. This is a functional first cut: plain, legible
markup; visual polish is deliberately out of scope.

Scoped to the owned-engine case (an app that constructs its own `ClientEngine`

- `ClientStore` in-process); attaching over the mirror seam needs a
  mirror-protocol introspection extension, tracked separately (#136).

Demonstrated in `examples/northwind`.
