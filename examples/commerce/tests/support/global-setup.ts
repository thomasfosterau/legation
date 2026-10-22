/**
 * The `commerce-browser` Vitest project's global setup (#289): builds the
 * commerce app once, before the run's test files start, and provides the
 * outcome to `facade-browser.test.ts` (see `build.ts`). Vitest runs a
 * project's global setup only when that project has test files in the run,
 * so a run that doesn't select the browser test doesn't pay for the build.
 *
 * Under `vitest` (watch mode) the app is rebuilt before each rerun that
 * includes this project's tests, so an edit to the app is never tested
 * against the previous build.
 */
import type { TestProject } from "vite-plus/test/node";
import { buildApp } from "./build.js";

export default function setup(project: TestProject): void {
  project.provide("commerceBuild", buildApp());
  project.onTestsRerun((specifications) => {
    if (specifications.some((specification) => specification.project.name === project.name)) {
      project.provide("commerceBuild", buildApp());
    }
  });
}
