# ADR-0020: SvelteKit integration — core SSR primitives, a thin kit package, effect-sveltekit at the app boundary

Date: 2026-07-03
Status: Accepted

## Context

The engine had no SvelteKit story: `@legation/svelte` shipped stores and rune
hooks but no SSR handling, and the only SSR primitive was the
framework-agnostic `Hydration` module (dehydrate → JSON → hydrate, with the
CVR cookie carried across so the first client pull continues the
conversation). React established the shape to mirror: hydrate the store
_before_ the engine, share the registry, no loading flash.

Two external libraries by the same author exist for the generic Effect v4 ⇄
Svelte boundary: `@thomasfosterau/effect-svelte` (runes hooks over
`AsyncResult`, runtime context) and `@thomasfosterau/effect-sveltekit`
(Effect-based `load`/actions/endpoints/hooks wrappers, per-request runtime
seam, Schema-driven `transport`, an Effect HTTP deployment adapter) — the
ADR-0016 question again: adopt or reimplement?

## Decision

Three placements, following ADR-0006's dependency test:

1. **SSR primitives live in core** (`Hydration` in `@legation/effect`): they
   need only `effect`. `Hydration.snapshot` produces a page snapshot over a
   request-scoped engine (in-memory store + in-process transport to the
   in-context `ServerHandler`, subscribe → pull → dehydrate) under the
   _browser's_ client group id, so the snapshot cookie continues that group's
   CVR conversation. `Hydration.hydrateIfEmpty` is the client-boot default
   over durable stores (a repeat visit's rows/cookie/journal are fresher than
   any snapshot). `Hydration.rowsFor` projects a snapshot onto a subset with
   `Subset.apply` — the synchronous initial value for component hooks during
   SSR and first client render.
2. **`@legation/sveltekit`** holds what binds to SvelteKit's types: the
   client-group cookie helper, `loadSnapshot` sugar, and the
   snapshot-hydrated `engineRuntime` boot. It depends on `@sveltejs/kit`
   (types) and stays deliberately thin.
3. **Apps author their Kit boundary with `@thomasfosterau/effect-sveltekit`**
   (loads, form actions, endpoints, per-request runtimes via
   `RequestRuntime`, deployment adapter). The library does not wrap it —
   `loadSnapshot` returns a plain Effect that runs inside any Effect-based
   `load`, so the integration composes rather than nests.

**`@legation/svelte`'s rune hooks remain native** rather than layering on
`@thomasfosterau/effect-svelte`: that library's runtime context is
deliberately type-erased (`RuntimeLike<never>`), while the binding's value is
the engine-typed context, and its stream hooks take static streams where the
engine hooks need reactive thunks (re-subscribe on `$state` change). The two
compose side by side in an app — effect-svelte for generic Effect concerns,
`@legation/svelte` for engine reads/writes.

## Consequences

- SSR works on any Effect-capable server framework — the Kit package is sugar,
  not a dependency of correctness; a Next.js or plain-Node SSR setup calls
  `Hydration.snapshot` directly.
- The client group id becomes an explicit, app-visible concept (a plain
  cookie, no authority — identity stays server-resolved via
  `IdentityResolver`).
- Snapshot hydration is empty-store-gated by default; a stale snapshot can
  never regress a durable store's cookie or clobber journalled offline
  mutations. Apps that want unconditional hydration call `Hydration.hydrate`
  themselves.
- No-JS writes are out-of-band writers (ADR-0019): form actions commit
  through the app's API and publish invalidation hints; they do not enter the
  mutation journal.
