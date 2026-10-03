/**
 * `@thomasfosterau/legation-svelte/kit` — the SvelteKit-shaped surface.
 *
 * Server: {@link clientGroupId} (the client-group cookie) and
 * {@link loadSnapshot} (the page's SSR snapshot, for any Effect-based `load`).
 * Client: {@link clientRuntime} (snapshot-hydrated Client boot).
 *
 * All three are thin: the hydration itself is `Hydration` in
 * `@thomasfosterau/legation-effect` and the wiring is `Client.make`. What lives here is only
 * what SvelteKit adds — a cookie, a `load`'s shape, and the `ManagedRuntime` a
 * root layout puts in context.
 *
 * `@sveltejs/kit` is an optional peer dependency and appears here only as a
 * `Cookies` *type*, so importing this subpath pulls no Kit runtime code.
 */
export * from "./clientGroup.js";
export * from "./load.js";
export * from "./boot.js";
