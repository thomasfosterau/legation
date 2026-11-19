/**
 * The environment variables the test files read at collection time, in one
 * place. Vitest decides `describe.skip` and builds the seeded corpora while
 * it collects a file, synchronously and before any test's Effect runs, so
 * there is no `Config` provider to read them through yet; this module is the
 * one place that reads `process.env` (scoped in the root `vite.config.ts`).
 */

/** The PostgreSQL database the `sql/` suites may reset; unset skips them locally. */
export const databaseUrl = process.env["DATABASE_URL"];

/** Whether the run is in CI, where a PostgreSQL suite must fail instead of skipping. */
export const inCi = process.env["CI"] !== undefined;

/** The `LEGATION_CORPUS_SEED` override for the seeded filter corpora (`FilterCorpus.resolveSeed`). */
export const corpusSeed = process.env["LEGATION_CORPUS_SEED"];
