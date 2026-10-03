/**
 * @thomasfosterau/legation-svelte
 *
 * Idiomatic Svelte bindings for the legation engine — minimal wrappers over
 * `@thomasfosterau/legation-effect`, plus the integrations where Svelte or SvelteKit can do
 * something the core cannot (reactive re-subscription, SSR hydration).
 *
 * One entry point, because the hooks are the API: `setClientRuntime` puts the
 * {@link Client} in context, and every read and write is a hook over it. This
 * module is `.svelte.ts` — the hooks own `$state`/`$effect`, so a bundler
 * compiles it through its Svelte plugin (the standard Svelte-library
 * convention, and why the package carries a `svelte` export condition).
 *
 * The SvelteKit-shaped surface — the client-group cookie, the SSR snapshot
 * `load`, and the snapshot-hydrated boot — lives on `@thomasfosterau/legation-svelte/kit`,
 * which is server-side and rune-free, so importing it pulls none of this in.
 */
export * from "./Runtime.js";
export * from "./hooks.svelte.js";
