# ADR-0020: SvelteKit integration — core SSR primitives, a thin kit package, effect-sveltekit at the app boundary

Date: 2026-07-03
Status: Accepted — amended 2026-09-01 (placement 2: the Kit package became the
`@thomasfosterau/legation-svelte/kit` subpath; `Hydration` is public and speaks `Query.Read`)
and 2026-10-23 (#215: a form action that can name the client group runs a named Mutation; see ADR-0030)

## Context

The engine had no SvelteKit story: `@thomasfosterau/legation-svelte` shipped stores and rune
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

1. **SSR primitives live in core** (`Hydration` in `@thomasfosterau/legation-effect`): they
   need only `effect`. `Hydration.snapshot` produces a page snapshot over a
   request-scoped engine (in-memory store + in-process transport to the
   in-context `ServerHandler`, subscribe → pull → dehydrate) under the
   _browser's_ client group id, so the snapshot cookie continues that group's
   CVR conversation. `Hydration.hydrateIfEmpty` is the client-boot default
   over durable stores (a repeat visit's rows/cookie/journal are fresher than
   any snapshot). `Hydration.rowsFor` projects a snapshot onto a read — the
   synchronous initial value for component hooks during SSR and first client
   render.
2. **The Kit surface** holds what binds to SvelteKit's types: the client-group
   cookie helper, `loadSnapshot` sugar, and the snapshot-hydrated boot. It
   depends on `@sveltejs/kit` (types) and stays deliberately thin.
3. **Apps author their Kit boundary with `@thomasfosterau/effect-sveltekit`**
   (loads, form actions, endpoints, per-request runtimes via
   `RequestRuntime`, deployment adapter). The library does not wrap it —
   `loadSnapshot` returns a plain Effect that runs inside any Effect-based
   `load`, so the integration composes rather than nests.

**`@thomasfosterau/legation-svelte`'s rune hooks remain native** rather than layering on
`@thomasfosterau/effect-svelte`: that library's runtime context is
deliberately type-erased (`RuntimeLike<never>`), while the binding's value is
the engine-typed context, and its stream hooks take static streams where the
engine hooks need reactive thunks (re-subscribe on `$state` change). The two
compose side by side in an app — effect-svelte for generic Effect concerns,
`@thomasfosterau/legation-svelte` for engine reads/writes.

## Amendment (2026-09-01)

Placement 2 shipped as a separate package, `@legation/sveltekit`. It is now the
**`@thomasfosterau/legation-svelte/kit` subpath** of the bindings package instead. ADR-0006's
dependency test drew the original line, but the footprint turned out not to
justify it: the package contained no Svelte code and its entire `@sveltejs/kit`
coupling was two `import type { Cookies }` statements, erased at build — so
there was no runtime dependency to isolate. `@sveltejs/kit` is an **optional**
peer of `@thomasfosterau/legation-svelte`; a non-Kit Svelte app pulls nothing, and subpath
exports keep the server helpers out of a client bundle that never imports them.

Two consequences of that move sharpen placement 1. `Hydration` was described
here as living in core but shipped behind `@thomasfosterau/legation-effect/internal`; it is
now exported from the package root, because an SSR snapshot is an app-facing
concept, not an implementation seam. And it speaks ADR-0022's vocabulary:
`snapshot({ nodes, reads })` and `rowsFor(snapshot, nodes, read)` rather than
`Subset`. The Kit boot is `clientRuntime` (over `Client.make`, so the sync loop
starts itself) rather than `engineRuntime`.

## Amendment (2026-10-23, #215): form actions that can name the client group

The out-of-band-writer line in Consequences split every write into two
authorings — a `Mutation` for the JS path and a form action for the no-JS
path — which is what `Mutation` exists to prevent. It now applies only to a
writer that **cannot** name the client group. A form action that can (the
client-group cookie above) runs a named Mutation as one of that group's
mutations — the push path's handler, the mutation id bumped in the same
transaction — and returns a receipt naming the mutation id, so a JS page
reconciles on it rather than waiting for a pull. The mechanism is core;
only the `Cookies` and form-field plumbing is the Kit subpath's. The
design, its receipt semantics and their relationship to façade writes are
[ADR-0030's #215 amendment](0030-facade-writes.md#amendment-215-a-form-action-runs-a-named-mutation-with-the-same-receipt-semantics).

## Consequences

- SSR works on any Effect-capable server framework — the Kit surface is sugar,
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
  _Amended 2026-10-23 (#215): this holds only for an action that cannot
  name the client group; see the amendment below._
