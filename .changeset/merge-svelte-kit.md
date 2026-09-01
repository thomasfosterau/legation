---
"@legation/effect": minor
"@legation/svelte": minor
---

`@legation/sveltekit` is merged into `@legation/svelte` as the
`@legation/svelte/kit` subpath, and `Hydration` moves to the public
`@legation/effect` surface.

The split was never a dependency boundary: the SvelteKit package contained no
Svelte code, and its whole `@sveltejs/kit` coupling was two `import type
{ Cookies }` statements — type-only, erased at build. `@sveltejs/kit` is now an
**optional** peer dependency of `@legation/svelte`, so a non-Kit Svelte app
pulls nothing extra, and only `@legation/svelte/kit` needs it.

The bindings shrink to one surface. The `Readable`-store tier (`Query.query` /
`namedQuery` / `aggregate` / `related`, `Mutation.getMutate`, `undoControls`,
and `Runtime.setEngineRuntime`) is removed: it duplicated the rune hooks, and
the package's own `svelte >= 5.40` peer already ruled out the Svelte 4 audience
it existed for. `Runes` gains **`useUndo(manager)`**, the rune equivalent of
the store-based `undoControls`, so nothing is lost.

Hydration is now a core concept rather than a SvelteKit one. `Hydration` is
exported from `@legation/effect` (it was behind `/internal`) and speaks
`Query.Read` instead of `Subset`: `snapshot({ nodes, reads })` and
`rowsFor(snapshot, nodes, read)`. `@legation/svelte/kit` keeps only the
framework's share — the client-group cookie, a `load`-shaped wrapper, and
`clientRuntime`, which replaces `engineRuntime` and returns the `Client`
runtime `setClientRuntime` expects (built on `Client.make`, so it starts the
sync loop itself).

Migration: `@legation/sveltekit` → `@legation/svelte/kit`;
`engineRuntime({ engine: {...} })` → `clientRuntime({ nodes, mutations, ... })`;
`setEngineRuntime` → `setClientRuntime`; `query(subset)` → `useQuery(() => read)`;
`getMutate()` → `useMutation()`; `undoControls(m)` → `useUndo(m)`;
`Hydration.rowsFor(snapshot, subset)` → `Hydration.rowsFor(snapshot, nodes, read)`.
