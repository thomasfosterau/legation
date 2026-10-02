/**
 * release
 *
 * Publishes the `@legation/*` packages with manifests a consumer can install
 * (#267). The packages depend on each other as `workspace:^` and reference the
 * root Bun catalog as `catalog:`; `npm pack` / `npm publish` (and so a plain
 * `changeset publish`) copy both verbatim, while `bun pm pack` rewrites them to
 * real ranges. `bun publish` would rewrite them too, but it has no npm OIDC
 * trusted publishing (it needs a stored token), so npm still does the upload:
 *
 * 1. `changeset pack` works out the publish plan (every non-private package
 *    whose current version is not on npm yet, in dependency order) and packs
 *    it. Already-published versions are left out, so a re-run after a partial
 *    failure publishes only what is missing.
 * 2. Each planned tarball is re-packed with `bun pm pack` in place, and its
 *    `package.json` is checked for a leftover `workspace:` / `catalog:`
 *    specifier (the run stops on the first one).
 * 3. `changeset publish --from-pack-dir` runs `npm publish <tarball>` for each
 *    one (npm >= 11.5.1 exchanges the workflow's OIDC token per package) and
 *    creates the git tags, reporting them to `changesets/action` through
 *    `CHANGESETS_OUTPUT` as a plain `changeset publish` would.
 *
 * `--dry-run` stops after step 2, leaving the plan and tarballs to inspect.
 *
 * `--check` packs every publishable package with `bun pm pack` and runs only
 * the manifest check, with no registry access: CI runs it on every pull
 * request so a specifier bun can't rewrite fails before a release does.
 *
 * Run `bun run build` first; `bun run release` does.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const changeset = join(root, "node_modules/.bin/changeset");
const check = process.argv.includes("--check");
const dryRun = process.argv.includes("--dry-run");

const run = (
  cmd: ReadonlyArray<string>,
  cwd: string,
  stdout: "pipe" | "inherit" = "pipe"
): string => {
  const proc = Bun.spawnSync([...cmd], { cwd, stdout, stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`\n\`${cmd.join(" ")}\` failed in ${cwd} (exit ${proc.exitCode}).`);
    process.exit(1);
  }
  return proc.stdout?.toString() ?? "";
};

/** Every string in the manifest that still carries a workspace-only protocol. */
const leftoverSpecifiers = (value: unknown, path: string): Array<string> => {
  if (typeof value === "string") {
    return /^(workspace|catalog):/.test(value) ? [`${path}: "${value}"`] : [];
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      leftoverSpecifiers(child, path === "" ? key : `${path}.${key}`)
    );
  }
  return [];
};

/** Packs `dir` with bun into `tarball` and fails if its manifest kept a `workspace:` / `catalog:` specifier. */
const bunPack = (dir: string, tarball: string): void => {
  run(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarball], dir);
  const manifest: unknown = JSON.parse(run(["tar", "-xzOf", tarball, "package/package.json"], dir));
  const leftovers = leftoverSpecifiers(manifest, "");
  const name = (manifest as { name?: unknown }).name;
  if (leftovers.length > 0) {
    console.error(
      `\n${String(name)}: the packed package.json still has\n  ${leftovers.join("\n  ")}`
    );
    process.exit(1);
  }
  console.log(`✓ ${String(name)}: no workspace: or catalog: specifiers in the packed package.json`);
};

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

const packageDirs = new Map<string, string>(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .map((dir) => [dir, readJson(join(dir, "package.json"))] as const)
    .filter(([, manifest]) => manifest.private !== true)
    .map(([dir, manifest]) => [manifest.name as string, dir])
);

if (check) {
  const outDir = mkdtempSync(join(tmpdir(), "legation-pack-check-"));
  for (const [name, dir] of [...packageDirs].toSorted(([a], [b]) => a.localeCompare(b))) {
    bunPack(dir, join(outDir, `${name.replace(/^@/, "").replace("/", "-")}.tgz`));
  }
  rmSync(outDir, { recursive: true, force: true });
  process.exit(0);
}

const packDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "legation-release-"));
run([changeset, "pack", "--out-dir", packDir], root, "inherit");

const planFile = join(packDir, "publish-plan.json");
const plan = readJson(planFile);
for (const release of plan.plan.flat()) {
  if (release.kind !== "publish") continue;
  const dir = packageDirs.get(release.name);
  if (dir === undefined) {
    console.error(`\n${release.name} is in the publish plan but not under packages/.`);
    process.exit(1);
  }
  const tarball = join(packDir, release.tarball.path);
  bunPack(dir, tarball);
  release.tarball.integrity = `sha256-${createHash("sha256").update(readFileSync(tarball)).digest("base64")}`;
}
writeFileSync(planFile, `${JSON.stringify(plan, undefined, 2)}\n`);

if (dryRun) {
  console.log(`\n--dry-run: stopping before \`changeset publish\`; the tarballs are in ${packDir}`);
  process.exit(0);
}

// stdin is inherited so a maintainer's interactive npm 2FA prompt works on a manual run.
const publish = Bun.spawnSync([changeset, "publish", "--from-pack-dir", packDir], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(publish.exitCode ?? 1);
