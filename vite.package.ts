/**
 * The one Vite+ configuration every published package in this workspace
 * shares: its `build` task and the `vp pack` (tsdown) settings. Each
 * `packages/<name>/vite.config.ts` is a one-call instantiation of it.
 *
 * Tests are not per package: the root `vite.config.ts` runs every suite as
 * one Vitest run (with source aliases), so the per-package config carries no
 * `test` block.
 */
import { defineConfig } from "vite-plus";

/** What differs per package. */
export interface PackageConfigOptions {
  /**
   * `pack.entry`: the output name (relative to `dist/`, without extension)
   * mapped to its source file, relative to the package directory.
   */
  readonly entries: Readonly<Record<string, string>>;
}

/**
 * Input fingerprint for a package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a build.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  "!dist/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

export const packageConfig = ({ entries }: PackageConfigOptions) =>
  defineConfig({
    run: {
      tasks: {
        // The published artifact: one ESM bundle + declaration file per
        // entry point. A sibling package is consumed through its `exports`
        // (so its `dist/`), hence the build edge on its dependencies.
        build: {
          command: "vp pack",
          dependsOn: [{ task: "build", from: "dependencies" }],
          cache: { input: cacheInputs, output: ["dist/**"] },
        },
      },
    },
    pack: {
      entry: { ...entries },
      format: "esm",
      // The core runs identically in browsers, workers, edge runtimes and
      // Node (ADR-0006): no platform shims.
      platform: "neutral",
      // `.js` / `.d.ts`, the names `exports` has always pointed at (and the
      // `.svelte.js` suffix the Svelte bindings' rune module needs).
      fixedExtension: false,
      // Nothing from npm is bundled, devDependencies included: a type-only
      // import of `@cloudflare/workers-types` (ambient declarations, no
      // exports) must stay an import in the emitted `.d.ts`, as tsc left it.
      deps: { neverBundle: true },
      dts: true,
      sourcemap: true,
      outDir: "dist",
      clean: true,
    },
  });
