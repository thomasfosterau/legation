/**
 * Entry point
 *
 * Build the sync world first (it forks the engine's sync loop and the in-page
 * demo server), then mount the Svelte app, handing it the engine `runtime` and
 * the demo `controls` as props. `App.svelte` puts them into context.
 */
import { mount } from "svelte";
import App from "./App.svelte";
import { createWorld } from "./sync";
import "./styles.css";

const target = document.getElementById("root");
if (target === null) throw new Error("Missing #root container");

const main = async (): Promise<void> => {
  const { runtime, controls, undo } = await createWorld();
  mount(App, { target, props: { runtime, controls, undo } });
};

void main();
