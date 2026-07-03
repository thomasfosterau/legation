import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

const alias = {
  "@legation/effect": pkg("effect"),
  "@legation/browser": pkg("browser"),
  "@legation/node": pkg("node"),
  "@legation/jsonapi": pkg("jsonapi"),
  "@legation/sql": pkg("sql"),
  "@legation/react": pkg("react"),
  "@legation/svelte": pkg("svelte"),
  "@legation/sveltekit": pkg("sveltekit"),
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
            "examples/svelte-commerce/tests/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "packages/svelte/**"],
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
          include: ["packages/svelte/src/**/*.test.ts"],
          server: {
            deps: {
              // Process effect-svelte through vite (browser conditions):
              // externalized, its `import "svelte"` would load Svelte's
              // SERVER runtime and every setContext call would throw
              // lifecycle_outside_component.
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
