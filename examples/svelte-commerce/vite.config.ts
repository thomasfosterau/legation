import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The sync server is its own process (`bun run dev:server`, port 3100); the
// dev server proxies both sync carriers to it so the browser talks same-origin.
export default defineConfig({
  plugins: [sveltekit()],
  // effect-svelte ships plain compiled JS (no `svelte` export condition), so
  // vite doesn't detect it as a Svelte library: prebundling would give it its
  // OWN copy of svelte's context internals and every setContext call would
  // throw lifecycle_outside_component. Keep it in the main module graph.
  optimizeDeps: {
    exclude: ["@thomasfosterau/effect-svelte"],
  },
  ssr: {
    noExternal: ["@thomasfosterau/effect-svelte"],
  },
  server: {
    port: 5178,
    proxy: {
      "/sync-ws": { target: "ws://localhost:3100", ws: true },
      "/sync": { target: "http://localhost:3100" },
    },
  },
});
