import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The svelte-commerce example's tsconfig extends SvelteKit's generated
 * `.svelte-kit/tsconfig.json`, which only exists after `svelte-kit sync`.
 * Fresh clones (and CI) haven't run the app's dev server, so materialize it
 * before vitest transforms the example's test files.
 */
export default function setup(): void {
  const app = fileURLToPath(new URL("examples/svelte-commerce", import.meta.url));
  if (!existsSync(`${app}/.svelte-kit/tsconfig.json`)) {
    execSync("bunx svelte-kit sync", { cwd: app, stdio: "inherit" });
  }
}
