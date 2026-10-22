/**
 * `vp run check:examples`: runs each `examples/*` app's own typecheck script —
 * `typecheck` (`tsc --noEmit`) for plain-TS apps, `check` (`svelte-check`) for
 * Svelte apps — against its own tsconfig.json. This is the counterpart to
 * `vp run check` (packages + tests only, via tsconfig.check.json): examples
 * aren't on that project's `include`, so binding-API changes in `packages/*`
 * could silently rot every example (#80). The task depends on `build`, so the
 * `@thomasfosterau/legation-*` packages resolve through their built `dist/`,
 * matching what the examples import at runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const examplesDir = new URL("../examples/", import.meta.url).pathname;
const dirs = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

let failed = false;

for (const dir of dirs) {
  const cwd = join(examplesDir, dir);
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const scripts = JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts ?? {};
  const script =
    scripts.typecheck !== undefined
      ? "typecheck"
      : scripts.check !== undefined
        ? "check"
        : undefined;
  if (script === undefined) {
    console.log(`\n▸ ${dir} — no typecheck/check script, skipping`);
    continue;
  }

  console.log(`\n▸ ${dir} (pnpm run ${script})`);
  const proc = spawnSync("pnpm", ["run", script], { cwd, stdio: "inherit" });
  if (proc.status !== 0) failed = true;
}

if (failed) {
  console.error("\nExample typecheck failed.");
  process.exit(1);
}
