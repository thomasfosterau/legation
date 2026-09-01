/**
 * @legation/svelte
 *
 * Idiomatic Svelte bindings for the legation engine — minimal wrappers over
 * `@legation/effect`, plus the integrations where Svelte or SvelteKit can do
 * something the core cannot (SSR hydration, reactive re-subscription).
 *
 * - `Runtime` — `setClientRuntime` / `getClientRuntime` (the Client in context)
 *
 * The rune hooks live on the `@legation/svelte/Runes` subpath (a
 * `.svelte.ts` module, so bundlers compile it under the `svelte` condition);
 * the SvelteKit-shaped surface — the client-group cookie, the SSR snapshot
 * `load`, and the snapshot-hydrated boot — lives on `@legation/svelte/kit`.
 */
export * as Runtime from "./Runtime.js";
