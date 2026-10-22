/**
 * `vp run pack:check`: packs every publishable package exactly as the release
 * does and runs the tarball checks in `pack.mjs`, with no registry access. CI
 * runs it on every pull request, after the build, so a specifier pnpm can't
 * rewrite or a broken manifest fails before a release does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackError, packAndCheck, packages } from "./pack.mjs";

const outDir = mkdtempSync(join(tmpdir(), "legation-pack-check-"));
const problems = [];
try {
  for (const name of packages.keys()) {
    try {
      // One package at a time: each tarball is checked in turn.
      // eslint-disable-next-line no-await-in-loop
      await packAndCheck(name, outDir);
    } catch (error) {
      if (!(error instanceof PackError)) throw error;
      problems.push(error.message);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n${problems.join("\n\n")}`);
  process.exitCode = 1;
}
