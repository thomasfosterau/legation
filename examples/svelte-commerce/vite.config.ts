import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The sync server is its own process (`bun run dev:server`, port 3100); the
// dev server proxies both sync carriers to it so the browser talks same-origin.
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5178,
    proxy: {
      "/sync-ws": { target: "ws://localhost:3100", ws: true },
      "/sync": { target: "http://localhost:3100" },
    },
  },
});
