import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

const alias = {
  "@thomasfosterau/legation-effect/internal": fileURLToPath(
    new URL("packages/effect/src/internal.ts", import.meta.url)
  ),
  "@thomasfosterau/legation-effect": pkg("effect"),
  "@thomasfosterau/legation-browser": pkg("browser"),
  "@thomasfosterau/legation-cloudflare": pkg("cloudflare"),
  "@thomasfosterau/legation-node": pkg("node"),
  "@thomasfosterau/legation-jsonapi": pkg("jsonapi"),
  "@thomasfosterau/legation-sql": pkg("sql"),
  "@thomasfosterau/legation-svelte/kit": fileURLToPath(
    new URL("packages/svelte/src/kit/index.ts", import.meta.url)
  ),
  "@thomasfosterau/legation-svelte": fileURLToPath(
    new URL("packages/svelte/src/index.svelte.ts", import.meta.url)
  ),
  "@thomasfosterau/legation-devtools": pkg("devtools"),
};

export default defineConfig({
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
            "tests/**/*.test.ts",
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
      reporter: ["text", "json", "html"],
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
