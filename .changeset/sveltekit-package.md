---
"@legation/sveltekit": minor
---

New package: SvelteKit integration for the legation engine (ADR-0020).
`clientGroupId` reads-or-mints the browser's client-group cookie;
`loadSnapshot` resolves it and produces the page's SSR snapshot over a
request-scoped engine inside any Effect-based `load`; `engineRuntime` boots
the client engine over a snapshot-hydrated durable store
(`Hydration.hydrateIfEmpty`) and yields the runtime `@legation/svelte`
consumes.
