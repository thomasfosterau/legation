/**
 * Loading the BUILT `@thomasfosterau/legation-node` where `redis` cannot be resolved (#254).
 *
 * `@effect/platform-node` declares a non-optional peer on `redis`, and its
 * root entry re-exports `NodeRedis`, which imports `redis` at module load.
 * A consumer that skips peers must still be able to import this package, so
 * it has to reach `NodeHttpServer` by subpath rather than through that root
 * entry.
 *
 * The check runs in a child Node process (Vitest aliases `@thomasfosterau/legation-node` to
 * source and runs its own loader, so only a plain `node` exercises the
 * published `dist/` the way an app does). `redis` stays installed in this
 * workspace; the child instead registers a module `resolve` hook that rejects
 * `redis` (and its `@redis/*` sub-packages) with the same
 * `ERR_MODULE_NOT_FOUND` Node raises for a missing package. That is
 * deterministic, needs no network or temp install, and is checked by two
 * controls: `redis` itself and the `@effect/platform-node` root entry must
 * both fail to load under the hook.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "redis" || specifier.startsWith("redis/") || specifier.startsWith("@redis/")) {
    const error = new Error("Cannot find package '" + specifier + "' (hidden by the #254 load test)");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return next(specifier, context);
}
`;

const register = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});
`;

/** Imports each specifier in order and reports `"ok"` or the error code. */
const probe = `
const results = {};
for (const specifier of ["redis", "@thomasfosterau/legation-node", "@effect/platform-node"]) {
  try {
    const module = await import(specifier);
    results[specifier] = specifier === "@thomasfosterau/legation-node"
      ? typeof module.HttpSyncServer?.layerHttp
      : "ok";
  } catch (error) {
    results[specifier] = error?.code ?? String(error);
  }
}
process.stdout.write(JSON.stringify(results));
`;

describe("@thomasfosterau/legation-node without redis", () => {
  // The child loads `dist/`, so build it (and `@thomasfosterau/legation-effect`, which it
  // references) first; a no-op when `bun run build` already ran, as in CI.
  beforeAll(() => {
    try {
      execFileSync(
        process.execPath,
        ["node_modules/@typescript/native/bin/tsc", "--build", "packages/node/tsconfig.json"],
        { cwd: root, stdio: "pipe" }
      );
    } catch (error) {
      // tsc prints its diagnostics on stdout, which the thrown error omits.
      const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      throw new Error(
        `tsc --build of packages/node failed:\n${failure.stdout?.toString() ?? ""}${
          failure.stderr?.toString() ?? ""
        }${failure.message}`
      );
    }
  }, 120_000);

  it("loads the built package when redis cannot be resolved", () => {
    const { NODE_OPTIONS: _ignored, ...env } = process.env;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(register)}`,
        "--input-type=module",
        "--eval",
        probe,
      ],
      { cwd: root, env, encoding: "utf8" }
    );

    expect(JSON.parse(output)).toEqual({
      // Controls: the hook hides redis, and the root entry needs it.
      redis: "ERR_MODULE_NOT_FOUND",
      "@effect/platform-node": "ERR_MODULE_NOT_FOUND",
      // The package loads and exposes its API.
      "@thomasfosterau/legation-node": "function",
    });
  }, 60_000);
});
