import { defineConfig } from "vite";

// Nothing special: Vite serves the TypeScript entry and bundles the engine
// (consumed from `../../packages/effect` as a built dependency). esbuild handles
// the Effect/FoldKit sources without extra plugins.
export default defineConfig({
  server: { port: 5173 },
});
