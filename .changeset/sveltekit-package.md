---
"@legation/svelte": minor
---

SvelteKit integration (ADR-0020), on the `@legation/svelte/kit` subpath.
`clientGroupId` reads-or-mints the browser's client-group cookie;
`loadSnapshot` resolves it and produces the page's SSR snapshot over a
request-scoped engine inside any Effect-based `load`; `clientRuntime` boots the
Client over a snapshot-hydrated durable store (`Hydration.hydrateIfEmpty`) and
yields the runtime `setClientRuntime` consumes.

`@sveltejs/kit` is an optional peer dependency and appears only as a `Cookies`
type, so a non-Kit Svelte app pulls nothing.
