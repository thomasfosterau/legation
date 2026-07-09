/**
 * @legation/devtools/svelte
 *
 * The Svelte panel entry point (#120): `DevtoolsPanel.svelte` is the thin
 * UI, `store.ts` bridges the headless core's Effects/Streams to Svelte
 * `Readable`s. Shipped as raw source — see `store.ts`'s module doc.
 */
export { default as DevtoolsPanel } from "./DevtoolsPanel.svelte";
export * from "./store.js";
