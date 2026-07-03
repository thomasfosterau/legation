/**
 * @legation/svelte
 *
 * Idiomatic Svelte bindings for the legation engine, exposed as namespaced
 * modules in the Effect idiom:
 *
 * - `Runtime` — `setEngineRuntime` / `getEngineRuntime` (runtime context)
 * - `Query` — `query` / `namedQuery` / `aggregate` / `related` live stores
 * - `Mutation` — `getMutate` / `getMutateWithAck`
 * - `Undo` — undo/redo over the engine's history
 *
 * The rune hooks live on the `@legation/svelte/Runes` subpath (a
 * `.svelte.ts` module, so bundlers compile it under the `svelte` condition).
 */
export * as Runtime from "./Runtime.js";
export * as Query from "./Query.js";
export * as Mutation from "./Mutation.js";
export * as Undo from "./Undo.js";
