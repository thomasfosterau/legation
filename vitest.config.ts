import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@legation/effect": pkg("core"),
      "@legation/browser": pkg("browser"),
      "@legation/node": pkg("node"),
      "@legation/jsonapi": pkg("jsonapi"),
      "@legation/sql": pkg("sql"),
      "@legation/react": pkg("react"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
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
