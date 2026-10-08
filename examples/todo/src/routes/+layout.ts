/**
 * Root load
 *
 * Builds the sync world once, for the lifetime of the app. `createWorld`
 * starts a `ManagedRuntime` that owns the engine's sync loop and the in-page
 * demo server, so it must run exactly once — a root `load` is that place:
 * SvelteKit runs it a single time on boot and re-uses its result across every
 * client-side navigation.
 *
 * The engine, its durable `localStorage` store, and the demo backend are all
 * browser-only, so this app renders entirely on the client. With `ssr = false`
 * this universal load never runs on the server, and its return value reaches
 * the components as-is (no serialization boundary to cross).
 */
import type { LayoutLoad } from "./$types";
import { createWorld } from "#lib/sync.js";

export const ssr = false;

export const load: LayoutLoad = async () => ({ world: await createWorld() });
