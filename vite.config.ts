/**
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`), the root tasks (`build`,
 * `check`, `check:examples`, `pack:check`, `test`, `test:coverage`, `bench`)
 * and the one Vitest run that covers every package and the example apps.
 * Each package's own `build` (`vp pack`) is defined once in `vite.package.ts`
 * and instantiated by its `packages/<name>/vite.config.ts`; a new package adds
 * itself to the `packages` list below.
 */
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@mpsuesser/oxlint-plugin-effect";
import { defineConfig } from "vite-plus";

/** The published packages, by directory; each has a `build` task. */
const packages = [
  "effect",
  "browser",
  "cloudflare",
  "devtools",
  "jsonapi",
  "node",
  "sql",
  "svelte",
] as const;

/** Every package's `build`, named explicitly: the root has no package deps. */
const buildAll = packages.map((name) => `@thomasfosterau/legation-${name}#build`);

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Tests import the packages by name, exactly as a consumer would, and resolve
 * that name to `src/` rather than the built `dist/` that `exports` points at,
 * so a unit run never needs a build first. (The commerce façade's browser test
 * builds the example app, which resolves through `dist/`; hence the `build`
 * edge on the test tasks.)
 */
const alias = {
  "@thomasfosterau/legation-effect/internal": source("packages/effect/src/internal.ts"),
  "@thomasfosterau/legation-effect": source("packages/effect/src/index.ts"),
  "@thomasfosterau/legation-browser": source("packages/browser/src/index.ts"),
  "@thomasfosterau/legation-cloudflare": source("packages/cloudflare/src/index.ts"),
  "@thomasfosterau/legation-node": source("packages/node/src/index.ts"),
  "@thomasfosterau/legation-jsonapi": source("packages/jsonapi/src/index.ts"),
  "@thomasfosterau/legation-sql": source("packages/sql/src/index.ts"),
  "@thomasfosterau/legation-svelte/kit": source("packages/svelte/src/kit/index.ts"),
  "@thomasfosterau/legation-svelte": source("packages/svelte/src/index.svelte.ts"),
  "@thomasfosterau/legation-devtools": source("packages/devtools/src/index.ts"),
};

/**
 * Input fingerprint for the cached root tasks: auto tracking minus
 * node_modules bookkeeping churn, with the lockfile back explicitly.
 */
const cacheInputs = [{ auto: true }, "!node_modules/**", "!coverage/**", "pnpm-lock.yaml"];

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit). Oxfmt cannot format
  // `.svelte`, so Svelte goes through lint alone.
  staged: {
    "*.{js,mjs,ts,json,md,yml,yaml}": "vp check --fix",
    "*.svelte": "vp lint --fix",
  },
  // Oxfmt, the formatter of record. The options keep the style the
  // repository was written in under Prettier, so the migration reformatted
  // nothing. The example apps, the vendored skills and ADR-0012/0013's
  // native ports are not formatted.
  fmt: {
    printWidth: 100,
    trailingComma: "es5",
    ignorePatterns: [
      "**/dist/**",
      "coverage/**",
      "examples/**",
      ".claude/skills/**",
      ".changeset/*.md",
      "**/CHANGELOG.md",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "coverage/**",
      "**/node_modules/**",
      ".changeset/**",
      // The example apps are demo code type-checked by their own
      // svelte-check (`vp run check:examples`); the library lint does not
      // apply to them.
      "examples/**",
    ],
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "eslint/no-underscore-dangle": ["warn", { allow: ["_tag"] }],
      "typescript/no-explicit-any": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      // Every `postMessage` here is a `BroadcastChannel` / `MessagePort` /
      // worker post, none of which takes a `targetOrigin` (that argument
      // exists only on `Window.postMessage`, which nothing here calls).
      "unicorn/require-post-message-target-origin": "off",
      // `casting-awareness` is an awareness prompt, not a defect rule: it
      // fires on every `as`, including the narrowings the platform types
      // (IndexedDB, Durable Objects, WebSocket) structurally require. Stays
      // visible as a warning.
      "effect/casting-awareness": "warn",

      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` also fires on `?: T | undefined`, which is
      // the ONLY spelling of an optional member `exactOptionalPropertyTypes`
      // lets a caller forward an optional of its own into (AGENTS.md), and on
      // the `undefined`-returning lookups the engine's public API is written
      // in. A bare `null` in a return type is still a finding to read.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at the boundaries this engine sits on:
      // a row value before its collection's schema decodes it, a mutator's
      // encoded args, a caught failure. Parsing them earlier would decode
      // twice or change the wire shape.
      "effect/no-unknown-parameters": "warn",
      // The same boundary on the way out: exported combinators over untyped
      // row values (`Incremental`, `Derive`, `Predicate.fieldValue`) and a
      // dialect's driver-specific bind value return what the caller's
      // projection or driver produces.
      "effect/no-unknown-returns": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-runtime-typeof": "warn",

      // ---- Effect preset: ported-code allowances ---------------------------
      // The engine predates the Effect oxlint preset. The rules below sit at
      // `warn` with the count left when it was adopted, so the code stays
      // committable while each site stays reported; a new site is a defect,
      // not headroom. Once a rule's count reaches zero its line is deleted,
      // so it is back at the preset's `error`. The remaining sites are listed
      // in #497 (see AGENTS.md "Effect").
      "effect/avoid-native-object-helpers": "warn", // 701 sites
      "effect/require-safety-comment-for-type-assertion": "warn", // 622 sites
      "effect/imperative-loops": "warn", // 659 sites
      "effect/yield-in-for-loop": "warn", // 637 sites
      "effect/avoid-non-null-assertion": "warn", // 345 sites
      "effect/avoid-direct-tag-checks": "warn", // 170 sites
      "effect/avoid-direct-json": "warn", // 161 sites
      "effect/no-conditional-empty-object-spread": "warn", // 146 sites
      "effect/effect-run-in-body": "warn", // 123 sites
      "effect/prefer-effect-fn": "warn", // 124 sites
      "effect/no-known-value-widening": "warn", // 101 sites
      "effect/avoid-untagged-errors": "warn", // 75 sites
      "effect/require-effect-concurrency": "warn", // 73 sites
      "effect/effect-promise-vs-trypromise": "warn", // 66 sites
      "effect/prefer-match-over-switch": "warn", // 50 sites
      "effect/avoid-schema-suffix": "warn", // 41 sites
      "effect/require-schema-type-alias": "warn", // 30 sites
      "effect/avoid-data-tagged-error": "warn", // 24 sites
    },
    overrides: [
      // The Node runtime adapter (ADR-0006): `node:http` and the other
      // `node:*` modules are what this package exists to bind. Its server is
      // a server, so the HttpClient service the rule offers does not apply.
      {
        files: ["packages/node/src/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-http-client-service": "off",
        },
      },
      // A benchmark's console output is its product: it prints the numbers
      // it measured, outside any Effect runtime.
      {
        files: ["**/*.bench.ts"],
        rules: {
          "effect/use-console-service": "off",
        },
      },
      // Type-level tests: each expect-error directive IS the assertion (a
      // statement that must fail to compile), checked by the `check` task.
      {
        files: [
          "packages/effect/src/__tests__/typed-query.test.ts",
          "packages/effect/src/__tests__/node.test.ts",
        ],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // Test fixtures read the environment at collection time, before any
      // Effect runtime exists: `DATABASE_URL` selects the PostgreSQL suite and
      // `CI` turns its skip into a failure. Stays visible as a warning.
      {
        files: ["packages/*/src/**/__tests__/**"],
        rules: {
          "effect/avoid-process-env": "warn",
        },
      },
      // Build/test configs and the release scripts are evaluated by Vite,
      // Vitest and Node directly, before any Effect runtime exists: there is
      // no `Config` provider to read and no `FileSystem` service to call, so
      // `process.env` and `node:*` are the only things that work there.
      {
        files: ["**/vite.config.ts", "vite.package.ts", "scripts/**", "vitest.global-setup.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-temp-file-scoped": "off",
          // Plain Node build tooling (the pack checks, the publish step, the
          // example typecheck runner): `try`/`catch`, `typeof` and `JSON` on a
          // packed `package.json` are the idiom where no Effect runtime runs.
          "effect/avoid-try-catch": "off",
          "effect/prefer-effect-is": "off",
          "effect/no-runtime-typeof": "off",
          "effect/avoid-direct-json": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
          "effect/no-conditional-empty-object-spread": "off",
        },
      },
      {
        files: ["packages/*/src/**/__tests__/**/*.ts"],
        rules: {
          "vitest/no-standalone-expect": [
            "error",
            {
              additionalTestBlockFunctions: [
                "it.effect",
                "it.live",
                "it.scoped",
                "it.scopedLive",
                "it.layer",
              ],
            },
          ],
          "vitest/expect-expect": [
            "error",
            { assertFunctionNames: ["expect", "expect*", "check*"] },
          ],
          "vitest/valid-expect": ["error", { maxArgs: 2 }],
          "vitest/no-conditional-expect": "off",
          "vitest/require-to-throw-message": "off",
        },
      },
      {
        files: ["packages/*/src/**/__tests__/**/*.bench.ts"],
        rules: {
          "vitest/expect-expect": [
            "error",
            { assertFunctionNames: ["expect", "expect*", "check*", "bench", "bench.*"] },
          ],
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` task's job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
  },
  run: {
    tasks: {
      // Every package's `dist/` (`vp pack`), in dependency order.
      build: {
        command: "echo 'build: every package packed'",
        dependsOn: buildAll,
        cache: false,
      },
      // The type gate: every package's `src` and tests in one native,
      // Effect-patched `tsc` program (tsconfig.check.json maps the package
      // names to `src/`, so no build is needed first).
      check: {
        command: "tsc -p tsconfig.check.json",
        cache: { input: cacheInputs, output: [] },
      },
      // Each example app's own `tsc` / `svelte-check`. The apps resolve the
      // packages through `dist/`, as they do at runtime.
      "check:examples": {
        command: "node scripts/typecheck-examples.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      // Packs every publishable package the way the release does and lints
      // the tarball (scripts/pack-check.mjs). No registry access.
      "pack:check": {
        command: "node scripts/pack-check.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      test: {
        command: "vp test run",
        dependsOn: ["build"],
        cache: false,
      },
      // The whole suite under one coverage map (`coverage/coverage-final.json`),
      // which `fallow audit` reads for exact per-function CRAP scores
      // (`health.coverage` in .fallowrc.json). Run this before `fallow audit`.
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: ["build"],
        cache: false,
      },
      bench: {
        command: "vp test bench --run --reporter=verbose",
        cache: false,
      },
    },
  },
  resolve: {
    alias,
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Materializes the example app's generated tsconfig on fresh clones.
          globalSetup: ["./vitest.global-setup.ts"],
          include: [
            "packages/*/src/**/*.test.ts",
            "examples/commerce/tests/**/*.test.ts",
            "examples/realworld/tests/**/*.test.ts",
          ],
          // The binding tests mount components and need the `svelte`
          // project below; the /kit tests are plain node. The commerce
          // browser test runs in `commerce-browser`, after its build.
          exclude: [
            "**/node_modules/**",
            "packages/svelte/src/__tests__/**",
            "examples/commerce/tests/facade-browser.test.ts",
          ],
        },
      },
      {
        // The commerce façade's browser test serves the app's production
        // build. Its global setup builds the app once, before the parallel
        // test phase (#289): a `vite build` inside the test's `beforeAll`
        // competed with every other file for CPU, so its wall time scaled
        // with host load. Vitest runs the setup only when this project has
        // files in the run.
        extends: true,
        test: {
          name: "commerce-browser",
          environment: "node",
          globalSetup: [
            "./vitest.global-setup.ts",
            "./examples/commerce/tests/support/global-setup.ts",
          ],
          include: ["examples/commerce/tests/facade-browser.test.ts"],
          server: {
            deps: {
              // The test's `beforeAll` imports the app's built server
              // (`build/handler.js` and its ~60 chunks). Vitest inlines every
              // module outside node_modules, so without this the whole bundle
              // went through vite's transform pipeline in the main process and
              // back over RPC: about 4.5x the CPU of a native import (1.2 s
              // against 0.27 s). Under a load average of ~95 on 4 cores that
              // import alone took 113 s and timed the hook out at 120 s; loaded
              // natively it took 5-29 s (#472). The build is plain Node ESM:
              // load it the way `node build` serves it.
              external: [/\/examples\/commerce\/build\//],
            },
          },
        },
      },
      {
        // The Svelte bindings mount real components, so this project compiles
        // `.svelte` fixtures and resolves Svelte's client (browser) build.
        extends: true,
        // `experimental.async` so fixtures can exercise the binding's
        // awaitable surface (`Live.promise`) inside <svelte:boundary>.
        plugins: [svelte({ compilerOptions: { experimental: { async: true } } })],
        resolve: {
          conditions: ["browser"],
        },
        test: {
          name: "svelte",
          environment: "jsdom",
          include: ["packages/svelte/src/__tests__/**/*.test.ts"],
          server: {
            deps: {
              // Vitest externalizes node_modules by default — even a package
              // carrying a `svelte` export condition — so effect-svelte must
              // be inlined to run through vite's browser pipeline; externalized
              // its `import "svelte"` loads the SERVER runtime and every
              // provide()/setContext throws lifecycle_outside_component. (The
              // app's vite build needs no such flag: the `svelte` condition on
              // effect-svelte >= 0.3.2 makes vite-plugin-svelte handle it.)
              inline: ["@thomasfosterau/effect-svelte"],
            },
          },
          // Component tests poll the DOM while engine fibers settle; leave
          // headroom for cold-start transform/import under parallel workers.
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // `json` writes coverage-final.json, the map `fallow audit` reads.
      reporter: ["text-summary", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/__tests__/**", "packages/*/dist/**"],
      // Temporarily lowered during the v2 rebuild (ADRs 0007-0010) while
      // skeleton modules await their phase-2/3 implementations; restore to
      // 85/70/80/85 as coverage recovers.
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 65,
        lines: 70,
      },
    },
  },
});
