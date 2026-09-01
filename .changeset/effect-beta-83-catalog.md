---
"@legation/effect": patch
"@legation/browser": patch
"@legation/node": patch
"@legation/jsonapi": patch
"@legation/sql": patch
---

Bump the pinned Effect version from `4.0.0-beta.75` to `4.0.0-beta.83` across all
packages (no engine API changes; build, typecheck, and the full test suite pass
unchanged).

The version is now centralised in a root **Bun catalog**
(`package.json` → `workspaces.catalog`): every package's `devDependencies`
reference `effect`/`@effect/platform-*`/`@effect/vitest` as `catalog:`, while the
published `peerDependencies` keep the concrete `4.0.0-beta.83` string. The
`foldkit-todo` example joins the workspace so it shares the same `effect` version
as the engine instead of pinning its own.
