/**
 * Entry point
 *
 * Build the sync world first (it forks the engine's sync loop and the in-page
 * demo server), then mount the Svelte app, handing it the `world` as a prop.
 * `App.svelte` puts the engine runtime, the demo world, the data stores, and
 * the session into context.
 */
import { mount } from "svelte";
import App from "./App.svelte";
import { createWorld } from "./sync";

const target = document.getElementById("root");
if (target === null) throw new Error("Missing #root container");

const main = async (): Promise<void> => {
  const world = await createWorld();
  mount(App, { target, props: { world } });
};

void main();
