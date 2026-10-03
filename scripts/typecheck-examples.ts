/**
 * typecheck-examples
 *
 * Runs each `examples/*` app's own typecheck script — `typecheck` (`tsc
 * --noEmit`) for plain-TS apps, `check` (`svelte-check`) for Svelte apps —
 * against its own tsconfig.json. This is the CI-facing counterpart to `bun
 * run typecheck` (packages + tests only, via tsconfig.check.json): examples
 * aren't on that project's `include`, so binding-API changes in `packages/*`
 * can silently rot every example (#80). Requires `bun run build` first so the
 * `@thomasfosterau/legation-*` packages resolve through their built `dist/`, matching what
 * the examples import at runtime.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const examplesDir = new URL("../examples/", import.meta.url).pathname;
const dirs = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = false;

for (const dir of dirs) {
  const cwd = join(examplesDir, dir);
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) continue;

  const scripts = (await import(packageJsonPath, { with: { type: "json" } })).default.scripts ?? {};
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

  console.log(`\n▸ ${dir} (bun run ${script})`);
  const proc = Bun.spawnSync(["bun", "run", script], { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) failed = true;
}

if (failed) {
  console.error("\nExample typecheck failed.");
  process.exit(1);
}
