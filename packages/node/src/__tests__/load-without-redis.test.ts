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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** A stream of a child's output bytes, decoded and joined. */
const text = <E, R>(bytes: Stream.Stream<Uint8Array, E, R>) =>
  bytes.pipe(Stream.decodeText(), Stream.mkString);

/**
 * Run `node` with `args` from the workspace root and succeed with its stdout;
 * a non-zero exit dies with everything the child printed, labelled `what`.
 * `env`, when given, replaces the inherited environment.
 */
const runNode = (
  what: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string | undefined> | undefined
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(process.execPath, args, {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [text(child.stdout), text(child.stderr), child.exitCode],
        { concurrency: "unbounded" }
      );
      if (exitCode !== 0) {
        return yield* Effect.die(
          new Error(`${what} failed (exit code ${exitCode}):\n${stdout}${stderr}`)
        );
      }
      return stdout;
    })
  ).pipe(Effect.provide(NodeServices.layer));

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
  it.live(
    "loads the built package when redis cannot be resolved",
    () =>
      Effect.gen(function* () {
        // The child loads `dist/`, so build it (and `@thomasfosterau/legation-effect`,
        // which it references) first; a cache hit when `vp run build` already ran, as in CI.
        yield* runNode("vp run build of @thomasfosterau/legation-node", [
          "node_modules/vite-plus/bin/vp",
          "run",
          "@thomasfosterau/legation-node#build",
        ]);

        const { NODE_OPTIONS: _ignored, ...env } = process.env;
        const output = yield* runNode(
          "the load probe",
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(register)}`,
            "--input-type=module",
            "--eval",
            probe,
          ],
          env
        );

        expect(JSON.parse(output)).toEqual({
          // Controls: the hook hides redis, and the root entry needs it.
          redis: "ERR_MODULE_NOT_FOUND",
          "@effect/platform-node": "ERR_MODULE_NOT_FOUND",
          // The package loads and exposes its API.
          "@thomasfosterau/legation-node": "function",
        });
      }),
    // The build (up to 120 s cold) and the probe (60 s), as the two steps had.
    180_000
  );
});
