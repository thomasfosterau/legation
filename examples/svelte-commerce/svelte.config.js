import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Async Svelte: `await` in deriveds and templates — the live hooks'
    // `promise` field suspends <svelte:boundary> pending snippets.
    experimental: { async: true },
  },
  kit: {
    adapter: adapter(),
  },
};
