/**
 * Packs a workspace package the way the release does (`pnpm pack`) and fails
 * if the tarball is not publishable as is. Shared by `pack-check.mjs` (CI, no
 * registry access) and `publish.mjs` (the release), so the release uploads
 * exactly the tarball the checks passed.
 *
 * The packages depend on each other as `workspace:^` and reference the
 * `pnpm-workspace.yaml` catalogs as `catalog:` / `catalog:peers`; `pnpm pack`
 * rewrites all three to real ranges, while `npm pack` would copy them
 * verbatim (#267). The checks, run on the packed tarball:
 *
 * - no `workspace:` / `catalog:` specifier is left anywhere in its
 *   `package.json`;
 * - every `workspace:` dependency on another `@thomasfosterau/legation-*`
 *   package was rewritten against that package's current version;
 * - no `effect` / `@effect/*` peer is an exact version (ADR-0003: the
 *   published floor is an open range, see CONTRIBUTING.md "Effect version
 *   upgrades");
 * - every target under a `svelte` export condition is in the tarball, and a
 *   package that ships Svelte modules has one (publint checks only the
 *   JavaScript targets under a custom condition);
 * - `publint` (strict: warnings fail too) finds nothing wrong with
 *   `exports` / `main` / `types`, `files` or `sideEffects`;
 * - `attw` (arethetypeswrong) finds no type-resolution problem for the
 *   resolution modes an ESM-only package supports (#250).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

export class PackError extends Error {}

export const root = new URL("../", import.meta.url).pathname;
const attw = join(root, "node_modules/.bin/attw");
const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/**
 * The publishable packages under `packages/`, by name, with their source
 * manifest, in dependency order (a package after every sibling it depends
 * on), so a consumer never resolves a sibling version not yet on the
 * registry.
 */
export const packages = (() => {
  const dir = join(root, "packages");
  const all = new Map(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .map((pkgDir) => ({ dir: pkgDir, manifest: readJson(join(pkgDir, "package.json")) }))
      .filter(({ manifest }) => manifest.private !== true)
      .map((pkg) => [pkg.manifest.name, pkg])
  );
  const ordered = new Map();
  const visit = (name) => {
    if (ordered.has(name)) return;
    const pkg = all.get(name);
    for (const field of dependencyFields) {
      for (const dep of Object.keys(pkg.manifest[field] ?? {})) {
        if (all.has(dep) && dep !== name) visit(dep);
      }
    }
    ordered.set(name, pkg);
  };
  for (const name of [...all.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) visit(name);
  return ordered;
})();

/** Every string in the manifest that still carries a workspace-only protocol. */
const leftoverSpecifiers = (value, path) => {
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
const expectedRange = (specifier, version) => {
  const range = specifier.slice("workspace:".length);
  if (range === "^" || range === "~") return `${range}${version}`;
  if (range === "*") return version;
  return range;
};

/** Every internal dependency whose packed range doesn't match the dependency's version. */
const staleInternalRanges = (source, packed) =>
  dependencyFields.flatMap((field) =>
    Object.entries(source[field] ?? {}).flatMap(([name, specifier]) => {
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

/** Every `effect` / `@effect/*` peer pinned to an exact version. */
const exactEffectPeers = (packed) =>
  Object.entries(packed.peerDependencies ?? {})
    .filter(([name]) => name === "effect" || name.startsWith("@effect/"))
    .filter(([, range]) => exactVersion.test(range.trim()))
    .map(([name, range]) => `peerDependencies.${name}: "${range}" is exact; publish an open range`);

/** Every `[path, target]` under a `svelte` condition in `exports`. */
const svelteTargets = (value, path, underSvelte) => {
  if (typeof value === "string") return underSvelte ? [[path, value]] : [];
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      svelteTargets(child, `${path}[${JSON.stringify(key)}]`, underSvelte || key === "svelte")
    );
  }
  return [];
};

/**
 * publint skips the file check for a non-JavaScript target under a custom
 * condition (`@thomasfosterau/legation-devtools` ships `./svelte` as raw `.ts`
 * and `.svelte` source), so this checks that every target under a `svelte`
 * condition is packed, and that a package shipping Svelte modules declares a
 * `svelte` condition at all.
 */
const svelteConditionProblems = (packed, files) => {
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
const publintProblems = async (tarball) => {
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
const attwIgnoredResolutionKinds = new Set(["node10", "node16-cjs"]);

/** The resolution kinds an attw `resolutionOption` covers (`node16` is both CJS and ESM). */
const attwResolutionKinds = {
  node10: ["node10"],
  node16: ["node16-cjs", "node16-esm"],
  bundler: ["bundler"],
};

/** attw findings that are not problems in the published package, each with the reason. */
const attwSuppressions = [
  {
    packageName: "@thomasfosterau/legation-devtools",
    kind: "InternalResolutionError",
    moduleSpecifier: "./DevtoolsPanel.svelte",
    reason:
      "attw type-checks the tarball without the `svelte` peer, so nothing declares `*.svelte` modules. A consumer of `./svelte` has `svelte` installed, whose types declare `*.svelte` (loaded through the entry's own `svelte/store` import), and `examples/northwind` type-checks this import with svelte-check.",
  },
];

/** attw's findings for the tarball, less the ignored resolution modes and the suppressions. */
const attwProblems = (name, tarball) => {
  const proc = spawnSync(attw, [tarball, "--profile", "esm-only", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  let result;
  try {
    result = JSON.parse(proc.stdout);
  } catch {
    throw new PackError(`\`attw ${tarball}\` printed no JSON (exit ${proc.status}).`);
  }
  if (result.analysis?.types === false) return ["attw: the package has no type declarations"];
  return (result.analysis?.problems ?? [])
    .filter((problem) => {
      const kinds =
        problem.resolutionKind !== undefined
          ? [problem.resolutionKind]
          : (attwResolutionKinds[problem.resolutionOption] ?? []);
      return kinds.length === 0 || kinds.some((kind) => !attwIgnoredResolutionKinds.has(kind));
    })
    .filter(
      (problem) =>
        !attwSuppressions.some(
          (suppression) =>
            suppression.packageName === name &&
            suppression.kind === problem.kind &&
            suppression.moduleSpecifier === problem.moduleSpecifier
        )
    )
    .map((problem) => {
      const where = problem.entrypoint ?? problem.fileName ?? "";
      const mode = problem.resolutionKind ?? problem.resolutionOption ?? "";
      const specifier =
        problem.moduleSpecifier === undefined ? "" : ` importing "${problem.moduleSpecifier}"`;
      return `attw ${problem.kind}: ${where}${specifier} (${mode})`;
    });
};

/**
 * Packs `name` with `pnpm pack` into `outDir`, checks the tarball, and
 * returns its path. Throws `PackError` listing every problem found.
 */
export const packAndCheck = async (name, outDir) => {
  const pkg = packages.get(name);
  if (pkg === undefined) throw new PackError(`${name} is not a publishable package.`);
  const before = new Set(readdirSync(outDir));
  execFileSync("pnpm", ["pack", "--pack-destination", outDir], { cwd: pkg.dir, stdio: "pipe" });
  const file = readdirSync(outDir).find((entry) => !before.has(entry));
  if (file === undefined) throw new PackError(`pnpm pack produced no tarball for ${name}.`);
  const tarball = join(outDir, file);
  const packed = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })
  );
  const files = new Set(
    execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean)
  );
  const problems = [
    ...leftoverSpecifiers(packed, ""),
    ...staleInternalRanges(pkg.manifest, packed),
    ...exactEffectPeers(packed),
    ...svelteConditionProblems(packed, files),
    ...(await publintProblems(tarball)),
    ...attwProblems(name, tarball),
  ];
  if (problems.length > 0) {
    throw new PackError(`${name}: the packed tarball has\n  ${problems.join("\n  ")}`);
  }
  console.log(
    `✓ ${name}: no workspace: or catalog: specifiers, internal ranges match, no exact effect peer, svelte conditions resolve, publint and attw (ESM-only) clean`
  );
  return tarball;
};
