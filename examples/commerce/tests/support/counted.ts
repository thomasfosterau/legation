/**
 * The commerce sync stack with its backend counted: every `evaluate` and
 * `getRows` the derived REST handlers make bumps `calls.n`, so a test can
 * assert "before any backend call" (`world.ts`) or "the server was never
 * asked for a locally served URL" (`app.ts`) as a fact. The Server's own
 * pulls keep the unwrapped backend; only what reads `CommerceSync.backend`
 * — the REST tier — is counted.
 */
import type { CommerceSync } from "../../server/runtime.js";

/** A mutable counter, shared with the wrapper. */
export interface Calls {
  n: number;
}

/** `sync` with its backend wrapped to count the REST tier's row reads. */
export const countedBackend = (sync: CommerceSync, calls: Calls): CommerceSync => ({
  ...sync,
  backend: {
    ...sync.backend,
    evaluate: (ctx, subset) => {
      calls.n++;
      return sync.backend.evaluate(ctx, subset);
    },
    getRows: (ctx, collection, ids) => {
      calls.n++;
      return sync.backend.getRows(ctx, collection, ids);
    },
  },
});
