import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The sync server is its own process (`bun run dev:server`, port 3100); the
// dev server proxies both sync carriers to it so the browser talks same-origin.
export default defineConfig({
  plugins: [sveltekit()],
  // Kit 2's server runtime imports `parse`/`serialize` from `cookie` 0.6, but
  // Kit 3 puts `cookie` 2 (which has neither) at the workspace root, and the
  // built server would resolve a bare `cookie` from there. Bundling it
  // resolves Kit's own copy instead.
  ssr: { noExternal: ["cookie"] },
  // effect-svelte carries a `svelte` export condition (>= 0.3.2), so
  // vite-plugin-svelte auto-detects it as a Svelte library and shares the
  // app's single copy of svelte — no manual optimizeDeps/noExternal needed.
  server: {
    port: 5178,
    proxy: {
      "/sync-ws": { target: "ws://localhost:3100", ws: true },
      "/sync": { target: "http://localhost:3100" },
    },
  },
});
