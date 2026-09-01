/**
 * World context
 *
 * The demo side-channel the engine's `query` / `getMutate` API doesn't cover:
 * the offline toggle and the live connection status. Shared via Svelte context
 * so the banner can read it from anywhere in the tree.
 */
import { readable, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import type { Transport } from "@legation/effect";
import type { World } from "./sync";

const WORLD_KEY = Symbol("svelte-northwind/world");

export const setWorld = (world: World): void => {
  setContext(WORLD_KEY, world);
};

export const getWorld = (): World => {
  const world = getContext<World | undefined>(WORLD_KEY);
  if (world === undefined) throw new Error("setWorld(world) must be called higher in the tree");
  return world;
};

/** Live transport connection status (emitted now and on every change). */
export const connectionStore = (world: World): Readable<Transport.ConnectionStatus> =>
  readable<Transport.ConnectionStatus>("connecting", (set) => world.subscribeConnection(set));
