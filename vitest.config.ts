import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

const alias = {
  "@legation/effect/internal": fileURLToPath(
    new URL("packages/effect/src/internal.ts", import.meta.url)
  ),
  "@legation/effect": pkg("effect"),
  "@legation/browser": pkg("browser"),
  "@legation/cloudflare": pkg("cloudflare"),
  "@legation/node": pkg("node"),
  "@legation/jsonapi": pkg("jsonapi"),
  "@legation/sql": pkg("sql"),
  "@legation/svelte/kit": fileURLToPath(
    new URL("packages/svelte/src/kit/index.ts", import.meta.url)
  ),
  "@legation/svelte": fileURLToPath(
    new URL("packages/svelte/src/index.svelte.ts", import.meta.url)
  ),
  "@legation/devtools": pkg("devtools"),
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
          ],
          // The binding tests mount components and need the `svelte`
          // project below; the /kit tests are plain node.
          exclude: ["**/node_modules/**", "packages/svelte/src/__tests__/**"],
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
