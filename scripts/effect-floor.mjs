/**
 * CI's `floor` job (`ci.yml`, "ci:floor (<floor>)"): points the workspace at
 * one published `effect` floor, checks the install holds only that floor, and
 * runs that floor's tests.
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
 * - `node scripts/effect-floor.mjs test` (the `ci:floor` task) runs the Vitest
 *   projects of the floor named by the `FLOOR` environment variable, after the
 *   build and Chromium for the floor that runs the commerce browser test.
 *
 * The rewrite exists only in the job's checkout; nothing is committed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Each floor's Vitest projects. `browser` floors also build first: the commerce
 * façade's browser test `vite build`s the example app, which resolves the
 * packages through their `exports` (`dist/`), and it needs Chromium.
 */
const floors = {
  core: { projects: ["node", "svelte"], browser: false },
  "alchemy-cloudflare": { projects: ["alchemy-cloudflare"], browser: false },
  auth: { projects: ["auth"], browser: false },
  jsonapi: { projects: ["jsonapi", "commerce-browser"], browser: true },
};

/** Runs one command, exiting with its status when it fails. */
const run = (command, args) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

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
} else if (command === "test") {
  const floor = floors[process.env.FLOOR ?? ""];
  if (floor === undefined) {
    console.error(`::error::FLOOR must be one of ${Object.keys(floors).join(", ")}`);
    process.exit(2);
  }
  if (floor.browser) {
    run("vp", ["run", "build"]);
    run("vp", ["run", "ci:chromium"]);
  }
  run("vp", ["test", "run", ...floor.projects.flatMap((name) => ["--project", name])]);
} else {
  console.error("usage: effect-floor.mjs point <catalog> | verify <version> | test");
  process.exit(2);
}
