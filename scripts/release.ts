/**
 * release
 *
 * Publishes the `@thomasfosterau/legation-*` packages with manifests a consumer can install
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
 * 2. Each planned tarball is re-packed with `bun pm pack` in place, and the
 *    tarball is checked (the run stops on the first package with a problem):
 *    - no `workspace:` / `catalog:` specifier is left anywhere in its
 *      `package.json`;
 *    - every `workspace:` dependency on another `@thomasfosterau/legation-*` package was
 *      rewritten against that package's current `package.json` version.
 *      `bun pm pack` takes workspace versions from `bun.lock`, not from
 *      `package.json`, so a lockfile that missed a version bump would publish
 *      the previous range. `bun run version` refreshes the lockfile;
 *    - no `effect` / `@effect/*` peer is an exact version (ADR-0003: the
 *      published floor is an open range, see CONTRIBUTING.md "Effect version
 *      upgrades");
 *    - every target under a `svelte` export condition is in the tarball, and a
 *      package that ships Svelte modules has one (publint checks only the
 *      JavaScript targets under a custom condition);
 *    - `publint` (strict: warnings fail too) finds nothing wrong with
 *      `exports` / `main` / `types`, `files` or `sideEffects`;
 *    - `attw` (arethetypeswrong) finds no type-resolution problem for the
 *      resolution modes an ESM-only package supports (#250).
 * 3. `changeset publish --from-pack-dir` runs `npm publish <tarball>` for each
 *    one (npm >= 11.5.1 exchanges the workflow's OIDC token per package) and
 *    creates the git tags, reporting them to `changesets/action` through
 *    `CHANGESETS_OUTPUT` as a plain `changeset publish` would.
 *
 * `--dry-run` stops after step 2, leaving the plan and tarballs to inspect.
 *
 * `--check` packs every publishable package with `bun pm pack` and runs only
 * the step 2 checks, with no registry access: CI runs it on every pull
 * request so a specifier bun can't rewrite, a stale `bun.lock` or a broken
 * manifest fails before a release does.
 *
 * Run `bun run build` first; `bun run release` does.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

class ReleaseError extends Error {}

const root = new URL("../", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const changeset = join(root, "node_modules/.bin/changeset");
const attw = join(root, "node_modules/.bin/attw");
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
 * Every internal (`@thomasfosterau/legation-*`) dependency whose packed range doesn't match
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

/** An exact version (`4.0.0`, `=4.0.0-rc.1`), as opposed to a range. */
const exactVersion = /^=?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Every `effect` / `@effect/*` peer pinned to an exact version. The published
 * floor is an open range (ADR-0003): an exact peer makes the package
 * impossible to install beside a library that needs a different release.
 */
const exactEffectPeers = (packed: any): Array<string> =>
  Object.entries<string>(packed.peerDependencies ?? {})
    .filter(([name]) => name === "effect" || name.startsWith("@effect/"))
    .filter(([, range]) => exactVersion.test(range.trim()))
    .map(([name, range]) => `peerDependencies.${name}: "${range}" is exact; publish an open range`);

/** Every `[path, target]` under a `svelte` condition in `exports`. */
const svelteTargets = (
  value: unknown,
  path: string,
  underSvelte: boolean
): Array<readonly [string, string]> => {
  if (typeof value === "string") return underSvelte ? [[path, value]] : [];
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      svelteTargets(child, `${path}[${JSON.stringify(key)}]`, underSvelte || key === "svelte")
    );
  }
  return [];
};

/**
 * publint reads a JavaScript target under a custom condition such as `svelte`,
 * but skips the file check for any other target under one (`@thomasfosterau/legation-devtools`
 * ships `./svelte` as raw `.ts` and `.svelte` source), so a Svelte-aware
 * bundler could resolve a file that isn't in the tarball without publint
 * noticing. Checks that every target under a `svelte` condition is packed,
 * and that a package shipping Svelte modules (`*.svelte`, `*.svelte.js`)
 * declares a `svelte` condition at all.
 */
const svelteConditionProblems = (packed: any, files: ReadonlySet<string>): Array<string> => {
  const targets = svelteTargets(packed.exports, "exports", false);
  const missing = targets
    .filter(([, target]) => !files.has(`package/${target.replace(/^\.\//, "")}`))
    .map(([path, target]) => `${path}: "${target}" is not in the tarball`);
  const shipsSvelte = [...files].some((file) => /\.svelte(?:\.js)?$/.test(file));
  return shipsSvelte && targets.length === 0
    ? [...missing, "ships Svelte modules but no export has a `svelte` condition"]
    : missing;
};

/** publint's errors and warnings (`strict` makes warnings errors) for the tarball. */
const publintProblems = async (tarball: string): Promise<Array<string>> => {
  const { messages, pkg } = await publint({
    pack: { tarball: new Uint8Array(readFileSync(tarball)).buffer },
    level: "warning",
    strict: true,
  });
  return messages.map(
    (message) => `publint ${message.code}: ${formatMessage(message, pkg, { color: false })}`
  );
};

/**
 * The resolution modes the attw check ignores. The packages are ESM-only by
 * design (`"type": "module"`, an `import` condition and no `require` one):
 * `node10` predates `exports`, so it can't see the subpath entries, and
 * `node16-cjs` is a `require()` from CommonJS, which gets an ESM file. These
 * are the modes attw's `esm-only` profile ignores; they are listed here because
 * attw applies its profile to its exit code only, not to its JSON output.
 */
const attwIgnoredResolutionKinds: ReadonlySet<string> = new Set(["node10", "node16-cjs"]);

/** The resolution kinds an attw `resolutionOption` covers (`node16` is both CJS and ESM). */
const attwResolutionKinds: Record<string, ReadonlyArray<string>> = {
  node10: ["node10"],
  node16: ["node16-cjs", "node16-esm"],
  bundler: ["bundler"],
};

/** attw findings that are not problems in the published package, each with the reason. */
const attwSuppressions: ReadonlyArray<{
  readonly packageName: string;
  readonly kind: string;
  readonly moduleSpecifier: string;
  readonly reason: string;
}> = [
  {
    packageName: "@thomasfosterau/legation-devtools",
    kind: "InternalResolutionError",
    moduleSpecifier: "./DevtoolsPanel.svelte",
    reason:
      "attw type-checks the tarball without the `svelte` peer, so nothing declares `*.svelte` modules. A consumer of `./svelte` has `svelte` installed, whose types declare `*.svelte` (loaded through the entry's own `svelte/store` import), and `examples/northwind` type-checks this import with svelte-check.",
  },
];

/** attw's findings for the tarball, less the ignored resolution modes and the suppressions. */
const attwProblems = (name: string, tarball: string): Array<string> => {
  const proc = Bun.spawnSync([attw, tarball, "--profile", "esm-only", "--format", "json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  let result: any;
  try {
    result = JSON.parse(proc.stdout.toString());
  } catch {
    throw new ReleaseError(`\`attw ${tarball}\` printed no JSON (exit ${proc.exitCode}).`);
  }
  if (result.analysis?.types === false) return ["attw: the package has no type declarations"];
  return (result.analysis?.problems ?? [])
    .filter((problem: any) => {
      const kinds: ReadonlyArray<string> =
        problem.resolutionKind !== undefined
          ? [problem.resolutionKind]
          : (attwResolutionKinds[problem.resolutionOption] ?? []);
      return kinds.length === 0 || kinds.some((kind) => !attwIgnoredResolutionKinds.has(kind));
    })
    .filter(
      (problem: any) =>
        !attwSuppressions.some(
          (suppression) =>
            suppression.packageName === name &&
            suppression.kind === problem.kind &&
            suppression.moduleSpecifier === problem.moduleSpecifier
        )
    )
    .map((problem: any) => {
      const where = problem.entrypoint ?? problem.fileName ?? "";
      const mode = problem.resolutionKind ?? problem.resolutionOption ?? "";
      const specifier =
        problem.moduleSpecifier === undefined ? "" : ` importing "${problem.moduleSpecifier}"`;
      return `attw ${problem.kind}: ${where}${specifier} (${mode})`;
    });
};

/** Packs `name` with bun into `tarball` and fails if it isn't publishable as is. */
const bunPack = async (name: string, tarball: string): Promise<void> => {
  const pkg = packages.get(name);
  if (pkg === undefined) {
    throw new ReleaseError(`${name} is in the publish plan but not under packages/.`);
  }
  run(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarball], pkg.dir);
  const packed = JSON.parse(run(["tar", "-xzOf", tarball, "package/package.json"], pkg.dir));
  const files = new Set(run(["tar", "-tzf", tarball], pkg.dir).split("\n").filter(Boolean));
  const stale = staleInternalRanges(pkg.manifest, packed);
  const problems = [
    ...leftoverSpecifiers(packed, ""),
    ...stale,
    ...exactEffectPeers(packed),
    ...svelteConditionProblems(packed, files),
    ...(await publintProblems(tarball)),
    ...attwProblems(name, tarball),
  ];
  if (problems.length > 0) {
    const hint =
      stale.length > 0
        ? "\nbun.lock missed a version bump: run `bun install --lockfile-only` (`bun run version` does)."
        : "";
    throw new ReleaseError(`${name}: the packed tarball has\n  ${problems.join("\n  ")}${hint}`);
  }
  console.log(
    `✓ ${name}: no workspace: or catalog: specifiers, internal ranges match package.json, no exact effect peer, svelte conditions resolve, publint and attw (ESM-only) clean`
  );
};

const checkAll = async (): Promise<void> => {
  const outDir = mkdtempSync(join(tmpdir(), "legation-pack-check-"));
  try {
    for (const name of [...packages.keys()].toSorted()) {
      // eslint-disable-next-line no-await-in-loop -- one package at a time: the run stops on the first problem
      await bunPack(name, join(outDir, `${name.replace(/^@/, "").replace("/", "-")}.tgz`));
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};

const release = async (): Promise<number> => {
  const packDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "legation-release-"));
  run([changeset, "pack", "--out-dir", packDir], root, "inherit");

  const planFile = join(packDir, "publish-plan.json");
  const plan = readJson(planFile);
  for (const entry of plan.plan.flat()) {
    if (entry.kind !== "publish") continue;
    const tarball = join(packDir, entry.tarball.path);
    // eslint-disable-next-line no-await-in-loop -- one package at a time: the run stops on the first problem
    await bunPack(entry.name, tarball);
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
    await checkAll();
    process.exitCode = 0;
  } else {
    process.exitCode = await release();
  }
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
