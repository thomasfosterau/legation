import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@thomasfosterau/effect-sync-core": pkg("core"),
      "@thomasfosterau/effect-sync-client": pkg("client"),
      "@thomasfosterau/effect-sync-cache": pkg("cache"),
      "@thomasfosterau/effect-sync-server": pkg("server"),
      "@thomasfosterau/effect-sync-jsonapi": pkg("jsonapi"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/__tests__/**", "packages/*/dist/**"],
    },
  },
});
