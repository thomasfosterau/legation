/**
 * @thomasfosterau/effect-sync-svelte
 *
 * Idiomatic Svelte bindings for the effect-sync engine: `query` / `namedQuery`
 * (live `Readable` stores over the mirror) and `getMutate`, over a
 * `ManagedRuntime` supplied with `setEngineRuntime`.
 */
export * from "./runtime.js";
export * from "./query.js";
export * from "./mutation.js";
