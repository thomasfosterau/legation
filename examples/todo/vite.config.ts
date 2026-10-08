import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `sveltekit()` supersedes the bare `svelte()` plugin: it adds the router, the
// generated `$types`, and the `#lib` subpath imports. The engine and its Svelte
// bindings are still consumed from `../../packages/*` as built dependencies
// (`workspace:*`).
export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // The whole world — engine, durable `localStorage` store, and the in-page
      // demo server — is browser-only (`ssr = false` in the root layout), so the
      // build is a static shell any host can serve: `fallback` hands every route
      // to the client router.
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],
  server: { port: 5175 },
});
