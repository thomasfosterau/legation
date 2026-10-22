import { packageConfig } from "../../vite.package.ts";

// The root entry keeps its `.svelte.js` suffix: it calls runes (`$state`,
// `$effect`), so the consumer's Svelte compiler must process it, and it only
// does for `*.svelte.js` modules.
export default packageConfig({
  entries: { "index.svelte": "src/index.svelte.ts", "kit/index": "src/kit/index.ts" },
});
