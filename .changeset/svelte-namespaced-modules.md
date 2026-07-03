---
"@legation/svelte": minor
---

The package now exposes namespaced modules in the Effect idiom, and only
those: `import { Runtime, Query, Mutation, Undo } from "@legation/svelte"`
(so `Runtime.setEngineRuntime`, `Query.query`, `Mutation.getMutate`,
`Undo.undoControls`); the rune hooks live on the `@legation/svelte/Runes`
subpath (`import * as Runes from "@legation/svelte/Runes"`). The flat
re-exports and the lowercase `./runes` subpath are removed.
