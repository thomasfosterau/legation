import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The Svelte plugin compiles `.svelte` files; the engine and its Svelte
// bindings are consumed from `../../packages/*` as built dependencies
// (`workspace:*`).
export default defineConfig({
  plugins: [svelte()],
  server: { port: 5175 },
});
