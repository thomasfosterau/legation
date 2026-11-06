/**
 * CI's "Tests (effect floor)" job (`ci.yml`): points the workspace at one
 * published `effect` floor, then checks the install holds only that floor.
 *
 * - `node scripts/effect-floor.mjs point <catalog>` reads the floor from the
 *   `effect` entry of `catalogs.<catalog>` in pnpm-workspace.yaml (`^X` -> `X`),
 *   rewrites every catalog and `overrides` entry versioned with effect (`effect`
 *   and the `@effect/*` runtime packages) to it, and prints it. `@effect/tsgo`
 *   and `@effect/language-service` are on their own release lines and keep
 *   their pins.
 * - `node scripts/effect-floor.mjs verify <version>` fails unless every
 *   `effect` / `@effect/*` runtime package in pnpm-lock.yaml resolved to
 *   `<version>`.
 *
 * The rewrite exists only in the job's checkout; nothing is committed.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [command, argument] = process.argv.slice(2);

/** Dev tooling on its own release line, not part of what the packages run on. */
const pinnedByHand = (name) =>
  name === "@effect/tsgo" ||
  name.startsWith("@effect/tsgo-") ||
  name === "@effect/language-service";

if (command === "point") {
  const file = "pnpm-workspace.yaml";
  const yaml = readFileSync(file, "utf8");
  // The named catalog's block (four-space entries under `  <catalog>:`), then
  // its `effect` entry.
  const block = yaml.match(new RegExp(`^ {2}${argument}:\\n((?: {4}.*\\n|\\s*#.*\\n)*)`, "m"));
  const peer = block?.[1].match(/^ {4}effect: "?(?:>=|\^)\s*([^"\s]+)"?$/m);
  if (peer === undefined || peer === null) {
    console.error(`::error::no effect floor under catalogs.${argument} in pnpm-workspace.yaml`);
    process.exit(1);
  }
  const floor = peer[1];
  // Top-level `catalog:` and `overrides:` entries (two-space indent) whose
  // value is a version, for effect and the @effect/* runtime.
  const rewritten = yaml.replace(
    /^ {2}("?)(effect|@effect\/[a-z0-9-]+)\1: \d\S*$/gm,
    (line, quote, name) => (pinnedByHand(name) ? line : `  ${quote}${name}${quote}: ${floor}`)
  );
  writeFileSync(file, rewritten);
  console.log(floor);
} else if (command === "verify") {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const resolved = [...lock.matchAll(/^ {2}'?((?:@effect\/[a-z0-9-]+)|effect)@([^:(']+)/gm)].filter(
    ([, name]) => !pinnedByHand(name)
  );
  const wrong = resolved.filter(([, , version]) => version !== argument);
  for (const [, name, version] of resolved) console.log(`${name}@${version}`);
  if (resolved.length === 0 || wrong.length > 0) {
    console.error(`::error::expected every effect package at ${argument}`);
    process.exit(1);
  }
} else {
  console.error("usage: effect-floor.mjs point <catalog> | verify <version>");
  process.exit(2);
}
