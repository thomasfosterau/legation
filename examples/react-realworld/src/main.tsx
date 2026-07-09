/**
 * Entry point
 *
 * Build the sync world (forks the engine sync loop + in-page demo server), then
 * mount React under the providers: `EffectSyncProvider` gives the bindings the
 * engine runtime, `WorldProvider` the demo controls, `AuthProvider` the session.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EffectSyncProvider } from "@legation/react";
import { createWorld } from "./sync";
import { WorldProvider } from "./world";
import { AuthProvider } from "./auth";
import { App } from "./App";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root container");

const main = async (): Promise<void> => {
  const world = await createWorld();
  createRoot(container).render(
    <React.StrictMode>
      <EffectSyncProvider atoms={world.atoms}>
        <WorldProvider world={world}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </WorldProvider>
      </EffectSyncProvider>
    </React.StrictMode>
  );
};

void main();
