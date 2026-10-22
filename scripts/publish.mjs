/**
 * The release workflow's publish step (`pnpm run release`, after the build):
 * every public workspace package whose current version is not yet on npm is
 * packed by pnpm, checked, and published by npm.
 *
 * Why not `changeset publish` or `pnpm publish -r`: the tarball that is
 * uploaded must be the one `pack.mjs` checked (publint strict, attw, no exact
 * effect peer, no leftover `workspace:` / `catalog:` specifier, Svelte export
 * conditions packed), so this packs once and uploads that file. Why not bare
 * `npm publish` in the package directory: npm does not understand pnpm's
 * `catalog:` and `workspace:` specifiers and would ship them verbatim (#267).
 * So `pnpm pack` rewrites the specifiers into the tarball and
 * `npm publish <tarball>` authenticates via OIDC trusted publishing (npm >=
 * 11.5.1). Nothing requests provenance: an explicit request fails from a
 * private repository, and npm attaches it by itself only where it is allowed.
 *
 * `changesets/action` creates the git tags and GitHub releases, but only for
 * what this script reports: one `{"type":"git-tag",…}` line per published
 * package, appended to the NDJSON file named by `CHANGESETS_OUTPUT`.
 *
 * Idempotent: a version already on the registry is skipped, so a re-run after
 * a partial failure publishes only what is missing. Packages go in dependency
 * order, so a consumer never resolves a sibling version not on the registry.
 *
 * `--dry-run` packs and checks the plan and prints where the tarballs are,
 * without publishing.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackError, packAndCheck, packages } from "./pack.mjs";

const dryRun = process.argv.includes("--dry-run");

const isPublished = (name, version) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch (error) {
    if (String(error.stderr ?? "").includes("E404")) return false;
    throw error;
  }
};

const packDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "legation-release-"));
const output = process.env.CHANGESETS_OUTPUT;
let published = 0;

try {
  for (const [name, { manifest }] of packages) {
    const { version } = manifest;
    if (isPublished(name, version)) {
      console.log(`skip     ${name}@${version} (already on npm)`);
      continue;
    }
    // One package at a time: the run stops on the first problem.
    // eslint-disable-next-line no-await-in-loop
    const tarball = await packAndCheck(name, packDir);
    if (dryRun) {
      console.log(`would publish ${name}@${version} (${tarball})`);
      continue;
    }
    // stdin is inherited so a maintainer's interactive npm 2FA prompt works on a manual run.
    execFileSync("npm", ["publish", tarball, "--access", "public"], { stdio: "inherit" });
    console.log(`publish  ${name}@${version}`);
    published += 1;
    if (output !== undefined && output !== "") {
      const event = { type: "git-tag", tag: `${name}@${version}`, packageName: name };
      appendFileSync(output, `${JSON.stringify(event)}\n`);
    }
  }
} catch (error) {
  if (!(error instanceof PackError)) throw error;
  console.error(`\n${error.message}`);
  process.exit(1);
}

console.log(
  dryRun
    ? `\n--dry-run: nothing published; the tarballs are in ${packDir}`
    : `${published} package(s) published`
);
