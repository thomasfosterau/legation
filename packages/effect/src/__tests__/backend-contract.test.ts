/**
 * Backend contract tests: the reference MemoryBackend satisfies
 * verifyBackendContract, and the suite actually catches violations.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Backend } from "../Backend.js";
import * as BackendContract from "../BackendContract.js";
import * as MemoryBackend from "../MemoryBackend.js";

describe("verifyBackendContract", () => {
  it.effect("MemoryBackend satisfies the contract", () =>
    MemoryBackend.make(BackendContract.memoryHandlers).pipe(
      Effect.flatMap((backend) => BackendContract.verifyBackendContract(backend))
    )
  );

  it.effect("catches a backend that re-applies acknowledged mutations", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(BackendContract.memoryHandlers);
      // Renumbering incoming mutation ids defeats idempotent skip: every
      // delivery applies, acknowledged or not.
      let sequence = 0;
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          inner.applyMutations(
            context,
            mutations.map((m) => ({ ...m, mutationId: ++sequence }))
          ),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("idempotency");
    })
  );

  it.effect("catches a backend that accepts mutation-id gaps", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(BackendContract.memoryHandlers);
      // Compacting gapped ids into the next expected slot silently accepts
      // gaps, breaking exactly-once delivery accounting. In-order and
      // already-applied ids pass through untouched.
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          Effect.flatMap(inner.lastMutationIds(context), (lastIds) => {
            const running = { ...lastIds };
            return inner.applyMutations(
              context,
              mutations.map((m) => {
                const last = running[m.clientId] ?? 0;
                const mutationId = m.mutationId > last + 1 ? last + 1 : m.mutationId;
                running[m.clientId] = Math.max(last, mutationId);
                return { ...m, mutationId };
              })
            );
          }),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("gaps");
    })
  );
});
