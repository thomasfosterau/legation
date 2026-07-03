/**
 * SvelteKit integration for the legation engine.
 *
 * Server: {@link clientGroupId} (client-group cookie) and {@link loadSnapshot}
 * (SSR snapshot over a request-scoped engine, for any Effect-based `load`).
 * Client: {@link engineRuntime} (snapshot-hydrated engine boot producing the
 * runtime `@legation/svelte` consumes).
 */
export * from "./clientGroup.js";
export * from "./load.js";
export * from "./boot.js";
