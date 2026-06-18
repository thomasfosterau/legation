/**
 * Entry point
 *
 * Build the sync world first (it forks the engine's sync loop and the demo
 * server), stash it for the FoldKit commands/subscriptions to reach, then
 * start the application.
 */

import { Runtime } from "foldkit";

import { createSyncWorld, setWorld } from "./sync";
import { Model, init, subscriptions, update, view } from "./main";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error('Missing #root container');

const main = async (): Promise<void> => {
  setWorld(await createSyncWorld());

  const application = Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    container,
  });

  Runtime.run(application);
};

void main();
