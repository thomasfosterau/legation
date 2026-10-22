/**
 * The Svelte config for the raw `./svelte` entry (`DevtoolsPanel.svelte`),
 * which ships as source and is compiled by the consuming app. svelte-check
 * (run by `examples/northwind`, which imports the panel) looks up the
 * nearest Svelte config from the component's own directory; without this
 * file it lands on this package's `vite.config.ts`, a `vp pack` config with
 * no Svelte plugin, and fails. Nothing here needs preprocessing.
 */
export default {};
