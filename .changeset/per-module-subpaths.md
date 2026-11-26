---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-alchemy-cloudflare": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-jsonapi": minor
---

Each module the root entry re-exports as a namespace is now also its own subpath, named after the namespace, as Effect's own packages are laid out: `import * as Node from "@thomasfosterau/legation/Node"` is the root's `Node`. The engine seams stay on `@thomasfosterau/legation/internal` only, and the deprecated `Mutator` alias has no subpath (use `/Mutation`). Nothing is removed: imports from the root entry keep working.
