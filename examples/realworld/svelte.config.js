import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // The whole world — engine, durable `localStorage` store, and the in-page
    // demo server — is browser-only (`ssr = false` in the root layout), so the
    // build is a static shell any host can serve: `fallback` hands every route
    // to the client router.
    adapter: adapter({ fallback: "index.html" }),
  },
};
