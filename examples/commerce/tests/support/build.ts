/**
 * The commerce app's production build for the façade's browser test
 * (#168), made once per Vitest run by `global-setup.ts` before any test
 * file starts (#289): a `vite build` is CPU-bound, and run inside the
 * test's `beforeAll` it competed with every other test file in the
 * parallel phase, so its wall time scaled with host load.
 *
 * The setup hands the outcome to the test through Vitest's `provide` /
 * `inject`, so the test only serves a build made by this run (never a stale
 * one left in `build/`), and a failed build fails the browser test with the
 * build's output rather than aborting the whole run.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The example's directory. */
export const appDir = fileURLToPath(new URL("../../", import.meta.url));

/** What the run's build came to: when it finished, or why it failed. */
export type CommerceBuild =
  | { readonly _tag: "Built"; readonly at: number }
  | { readonly _tag: "Failed"; readonly message: string };

declare module "vitest" {
  export interface ProvidedContext {
    /** The commerce app's build for this run (`global-setup.ts`). */
    readonly commerceBuild?: CommerceBuild;
  }
}

/** `vite build` the app (adapter-node), its output or failure as a `CommerceBuild`. */
export const buildApp = (): CommerceBuild => {
  try {
    execFileSync("bun", ["run", "build"], {
      cwd: appDir,
      env: { ...process.env, BETTER_AUTH_SECRET: "commerce-browser-test" },
      stdio: "pipe",
    });
    return { _tag: "Built", at: Date.now() };
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; message: string };
    return {
      _tag: "Failed",
      message: `vite build of examples/commerce failed:\n${failure.stdout?.toString() ?? ""}${
        failure.stderr?.toString() ?? ""
      }${failure.message}`,
    };
  }
};
