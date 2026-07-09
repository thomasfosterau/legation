/**
 * Entry point — build the sync world, then mount React under the engine runtime
 * and the world (demo controls) providers.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EffectSyncProvider } from "@legation/react";
import { createWorld } from "./sync";
import { WorldProvider } from "./world";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root container");

const main = async (): Promise<void> => {
  const world = await createWorld();
  createRoot(container).render(
    <React.StrictMode>
      <EffectSyncProvider atoms={world.atoms}>
        <WorldProvider world={world}>
          <App />
        </WorldProvider>
      </EffectSyncProvider>
    </React.StrictMode>
  );
};

void main();
