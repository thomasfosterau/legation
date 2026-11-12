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
import type { PackUserConfig } from "vite-plus/pack";

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

/**
 * The `vp pack` (tsdown) settings of a package: its entries, as one ESM
 * module per source module. The size tests pack through these too
 * (`packages/browser/src/__tests__/bundle-size.ts`), so what they measure is
 * what `vp pack` emits.
 */
export const packOptions = (entries: PackageConfigOptions["entries"]): PackUserConfig => ({
  entry: { ...entries },
  format: "esm",
  // The core runs identically in browsers, workers, edge runtimes and
  // Node (ADR-0006): no platform shims.
  platform: "neutral",
  // `.js` / `.d.ts`, the names `exports` has always pointed at (and the
  // `.svelte.js` suffix the Svelte bindings' rune module needs).
  fixedExtension: false,
  // Nothing from npm is bundled, devDependencies included: a peer (an
  // `effect` module, Alchemy's provider) must stay an import in the
  // emitted `.js` and `.d.ts`, so the consumer's single copy serves it.
  deps: { neverBundle: true },
  dts: true,
  sourcemap: true,
  outDir: "dist",
  clean: true,
  // One output module per source module (the `dist/` tree mirrors `src/`),
  // never a merged shared chunk: with `sideEffects: false` a consumer's
  // bundler drops every module it doesn't reach, which it can't do inside
  // one chunk. A merged chunk tied the error classes to the whole
  // MemoryBackend graph, so the Cache API HTTP cache alone bundled PubSub,
  // Metric and HashMap (#678).
  unbundle: true,
});

/** A package's whole Vite+ configuration: its `build` task and {@link packOptions}. */
export const packageConfig = ({ entries }: PackageConfigOptions) =>
  defineConfig({
    run: {
      tasks: {
        // The published artifact: one ESM module + declaration file per
        // source module, under one entry per export. A sibling package is
        // consumed through its `exports` (so its `dist/`), hence the build
        // edge on its dependencies.
        build: {
          command: "vp pack",
          dependsOn: [{ task: "build", from: "dependencies" }],
          cache: { input: cacheInputs, output: ["dist/**"] },
        },
      },
    },
    pack: packOptions(entries),
  });
