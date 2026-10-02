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
 *    `package.json` is checked (the run stops on the first problem):
 *    - no `workspace:` / `catalog:` specifier is left anywhere in it;
 *    - every `workspace:` dependency on another `@legation/*` package was
 *      rewritten against that package's current `package.json` version.
 *      `bun pm pack` takes workspace versions from `bun.lock`, not from
 *      `package.json`, so a lockfile that missed a version bump would publish
 *      the previous range. `bun run version` refreshes the lockfile.
 * 3. `changeset publish --from-pack-dir` runs `npm publish <tarball>` for each
 *    one (npm >= 11.5.1 exchanges the workflow's OIDC token per package) and
 *    creates the git tags, reporting them to `changesets/action` through
 *    `CHANGESETS_OUTPUT` as a plain `changeset publish` would.
 *
 * `--dry-run` stops after step 2, leaving the plan and tarballs to inspect.
 *
 * `--check` packs every publishable package with `bun pm pack` and runs only
 * the manifest checks, with no registry access: CI runs it on every pull
 * request so a specifier bun can't rewrite, or a stale `bun.lock`, fails
 * before a release does.
 *
 * Run `bun run build` first; `bun run release` does.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class ReleaseError extends Error {}

const root = new URL("../", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const changeset = join(root, "node_modules/.bin/changeset");
const check = process.argv.includes("--check");
const dryRun = process.argv.includes("--dry-run");
const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

const run = (
  cmd: ReadonlyArray<string>,
  cwd: string,
  stdout: "pipe" | "inherit" = "pipe"
): string => {
  const proc = Bun.spawnSync([...cmd], { cwd, stdout, stderr: "inherit" });
  if (proc.exitCode !== 0) {
    throw new ReleaseError(`\`${cmd.join(" ")}\` failed in ${cwd} (exit ${proc.exitCode}).`);
  }
  return proc.stdout?.toString() ?? "";
};

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

/** The publishable packages under `packages/`, by name, with their source manifest. */
const packages = new Map<string, { readonly dir: string; readonly manifest: any }>(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) }))
    .filter(({ manifest }) => manifest.private !== true)
    .map((pkg) => [pkg.manifest.name as string, pkg])
);

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

/** The range a `workspace:` specifier must become, given the target's current version. */
const expectedRange = (specifier: string, version: string): string => {
  const range = specifier.slice("workspace:".length);
  if (range === "^" || range === "~") return `${range}${version}`;
  if (range === "*") return version;
  return range;
};

/**
 * Every internal (`@legation/*`) dependency whose packed range doesn't match
 * the dependency's current `package.json` version, e.g. because `bun.lock`
 * still carries the version from before a bump.
 */
const staleInternalRanges = (source: any, packed: any): Array<string> =>
  dependencyFields.flatMap((field) =>
    Object.entries<string>(source[field] ?? {}).flatMap(([name, specifier]) => {
      const target = packages.get(name);
      if (target === undefined || !specifier.startsWith("workspace:")) return [];
      const expected = expectedRange(specifier, target.manifest.version);
      const actual = packed[field]?.[name];
      return actual === expected
        ? []
        : [
            `${field}.${name}: "${String(actual)}", expected "${expected}" (${name} is ${target.manifest.version})`,
          ];
    })
  );

/** Packs `name` with bun into `tarball` and fails if its manifest isn't publishable as is. */
const bunPack = (name: string, tarball: string): void => {
  const pkg = packages.get(name);
  if (pkg === undefined) {
    throw new ReleaseError(`${name} is in the publish plan but not under packages/.`);
  }
  run(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarball], pkg.dir);
  const packed = JSON.parse(run(["tar", "-xzOf", tarball, "package/package.json"], pkg.dir));
  const stale = staleInternalRanges(pkg.manifest, packed);
  const problems = [...leftoverSpecifiers(packed, ""), ...stale];
  if (problems.length > 0) {
    const hint =
      stale.length > 0
        ? "\nbun.lock missed a version bump: run `bun install --lockfile-only` (`bun run version` does)."
        : "";
    throw new ReleaseError(
      `${name}: the packed package.json has\n  ${problems.join("\n  ")}${hint}`
    );
  }
  console.log(
    `✓ ${name}: no workspace: or catalog: specifiers, internal ranges match package.json`
  );
};

const checkAll = (): void => {
  const outDir = mkdtempSync(join(tmpdir(), "legation-pack-check-"));
  try {
    for (const name of [...packages.keys()].toSorted()) {
      bunPack(name, join(outDir, `${name.replace(/^@/, "").replace("/", "-")}.tgz`));
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};

const release = (): number => {
  const packDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "legation-release-"));
  run([changeset, "pack", "--out-dir", packDir], root, "inherit");

  const planFile = join(packDir, "publish-plan.json");
  const plan = readJson(planFile);
  for (const entry of plan.plan.flat()) {
    if (entry.kind !== "publish") continue;
    const tarball = join(packDir, entry.tarball.path);
    bunPack(entry.name, tarball);
    entry.tarball.integrity = `sha256-${createHash("sha256").update(readFileSync(tarball)).digest("base64")}`;
  }
  writeFileSync(planFile, `${JSON.stringify(plan, undefined, 2)}\n`);

  if (dryRun) {
    console.log(
      `\n--dry-run: stopping before \`changeset publish\`; the tarballs are in ${packDir}`
    );
    return 0;
  }

  // stdin is inherited so a maintainer's interactive npm 2FA prompt works on a manual run.
  const publish = Bun.spawnSync([changeset, "publish", "--from-pack-dir", packDir], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return publish.exitCode ?? 1;
};

try {
  if (check) {
    checkAll();
    process.exitCode = 0;
  } else {
    process.exitCode = release();
  }
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
