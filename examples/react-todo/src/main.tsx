/**
 * Entry point
 *
 * Build the sync world first (it forks the engine's sync loop and the in-page
 * demo server), then mount React under the two providers: `EffectSyncProvider`
 * gives the hooks the engine runtime, `DemoProvider` gives the UI the demo
 * controls.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EffectSyncProvider } from "@legation/react";
import { createWorld } from "./sync";
import { DemoProvider } from "./demo";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root container");

const main = async (): Promise<void> => {
  const { atoms, controls } = await createWorld();
  createRoot(container).render(
    <React.StrictMode>
      <EffectSyncProvider atoms={atoms}>
        <DemoProvider controls={controls}>
          <App />
        </DemoProvider>
      </EffectSyncProvider>
    </React.StrictMode>
  );
};

void main();
