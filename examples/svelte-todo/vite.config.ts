import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// `sveltekit()` supersedes the bare `svelte()` plugin: it adds the router, the
// generated `$types`, and `$lib`. The engine and its Svelte bindings are still
// consumed from `../../packages/*` as built dependencies (`workspace:*`).
export default defineConfig({
  plugins: [sveltekit()],
  server: { port: 5175 },
});
