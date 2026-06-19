import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// `vitePreprocess` lets `<script lang="ts">` blocks use TypeScript.
export default {
  preprocess: vitePreprocess(),
};
