import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  // Kit 2's server runtime imports `parse`/`serialize` from `cookie` 0.6, but
  // Kit 3 puts `cookie` 2 (which has neither) at the workspace root, and the
  // built server would resolve a bare `cookie` from there. Bundling it
  // resolves Kit's own copy instead.
  ssr: { noExternal: ["cookie"] },
  server: { port: 5179 },
});
