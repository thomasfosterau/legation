/**
 * World context
 *
 * The demo side-channel the engine's `query` / `getMutate` API doesn't cover:
 * telling the *server* which user this client is (`setIdentity`), the offline
 * toggle, and connection status.
 */
import { readable, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import type { Transport } from "@thomasfosterau/effect-sync-core";
import type { World } from "./sync";

const WORLD_KEY = Symbol("svelte-realworld/world");

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
