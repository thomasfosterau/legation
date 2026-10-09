/**
 * Backend contract tests: the reference MemoryBackend satisfies
 * verifyBackendContract, and the suite actually catches violations.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Backend } from "../Backend.js";
import * as BackendContract from "../BackendContract.js";
import { BackendError } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as UnknownMutator from "../UnknownMutator.js";

/** The reference handlers without the named contract mutator, i.e. an unregistered one. */
const withoutHandler = (name: string) =>
  Object.fromEntries(
    Object.entries(BackendContract.memoryHandlers).filter(([key]) => key !== name)
  );

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

  it.effect("catches a backend that does not register the fail mutator", () =>
    Effect.gen(function* () {
      // An unregistered mutator fails with "Unknown mutator", a BackendError too: the
      // atomic-bump rule must not let that pass as the expected failure.
      const broken = yield* MemoryBackend.make(withoutHandler(BackendContract.failAlways.name));
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("atomic");
      expect(failure.message).toContain("not registered");
    })
  );

  it.effect("catches a backend that does not register the write-then-fail mutator", () =>
    Effect.gen(function* () {
      // An unregistered mutator fails with "Unknown mutator", a BackendError too: the
      // write-then-fail rule must not let that pass as the expected failure.
      const broken = yield* MemoryBackend.make(withoutHandler(BackendContract.writeThenFail.name));
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("discards");
      expect(failure.message).toContain("not registered");
    })
  );

  it.effect("detects an unregistered mutator by its typed cause, whatever the message says", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(withoutHandler(BackendContract.writeThenFail.name));
      // Rewords the unknown-mutator error but keeps its typed cause.
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          inner
            .applyMutations(context, mutations)
            .pipe(
              Effect.mapError(
                (error) => new BackendError({ message: "no such handler", cause: error.cause })
              )
            ),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure.rule).toContain("discards");
      expect(failure.message).toContain("not registered");
    })
  );

  it.effect("does not mistake a registered handler's error that mentions an unknown mutator", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(BackendContract.memoryHandlers);
      // Rewords every handler failure except the typed unknown-mutator one, so a
      // registered failAlways fails with text that contains "Unknown mutator".
      const wordy: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          inner
            .applyMutations(context, mutations)
            .pipe(
              Effect.mapError((error) =>
                UnknownMutator.isError(error)
                  ? error
                  : new BackendError({ message: `Unknown mutator: none here (${error.message})` })
              )
            ),
      };
      yield* BackendContract.verifyBackendContract(wordy);
    })
  );

  it.effect("catches a backend whose count-up read escapes the commit's validation", () =>
    Effect.gen(function* () {
      // The handler reads the counter from a snapshot the wrapper takes when the
      // call starts, not through the stage. MemoryBackend's read validation never
      // sees that read, so a peer group's commit between the read and the write is
      // overwritten: a lost update across client groups (rule 11).
      const snapshots = new Map<string, number>();
      const staleCount: MemoryBackend.BackendHandler = (raw, writer, context) => {
        const args = raw as {
          readonly collection: string;
          readonly id: string;
          readonly gate: string;
        };
        return Effect.gen(function* () {
          const seen = snapshots.get(context.clientGroupId) ?? 0;
          yield* BackendContract.park(args.gate);
          yield* writer.put(args.collection, args.id, { n: seen + 1 });
        });
      };
      const inner = yield* MemoryBackend.make({
        ...BackendContract.memoryHandlers,
        [BackendContract.countUp.name]: staleCount,
      });
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          Effect.gen(function* () {
            const [row] = yield* inner.getRows(context, "__contract", ["race"]);
            snapshots.set(
              context.clientGroupId,
              Number((row?.value as { readonly n?: number } | undefined)?.n ?? 0)
            );
            return yield* inner.applyMutations(context, mutations);
          }),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("guarantee 1");
      expect(failure.message).toContain("lost");
    })
  );

  it.effect("falls back to the message for a backend that carries no typed cause", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(withoutHandler(BackendContract.writeThenFail.name));
      // Drops the typed cause, keeping the "Unknown mutator" message.
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          inner
            .applyMutations(context, mutations)
            .pipe(Effect.mapError((error) => new BackendError({ message: error.message }))),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure.rule).toContain("discards");
      expect(failure.message).toContain("not registered");
    })
  );
});
