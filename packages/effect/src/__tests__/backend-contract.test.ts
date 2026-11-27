/**
 * Backend contract tests: the reference MemoryBackend satisfies
 * verifyBackendContract, and the suite actually catches violations.
 */
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { Backend, evaluateAll, evaluateCountedAll, totalsOf } from "../Backend.js";
import * as BackendContract from "../BackendContract.js";
import { BackendError } from "../Errors.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Subset from "../Subset.js";
import * as UnknownMutator from "../UnknownMutator.js";
import { ClientGroupId, MutationId, RowId } from "../Protocol.js";

/** The reference handlers without the named contract mutator, i.e. an unregistered one. */
const withoutHandler = (name: string) =>
  Effect.map(BackendContract.makeMemoryHandlers, (handlers) => R.remove(handlers, name));

/** A contract counter row's value, absent before its first count. */
const decodeCounter = Schema.decodeUnknownSync(
  Schema.UndefinedOr(Schema.Struct({ n: Schema.optional(Schema.Finite) }))
);

// The documented shape: the backend from a layer, the contract run under `it.effect`.
// The handlers park at the gates the contract opens, so both share one ParkGates.
const ContractBackend = Layer.unwrap(
  Effect.map(BackendContract.makeMemoryHandlers, MemoryBackend.layer)
).pipe(Layer.provideMerge(BackendContract.layerParkGates));

layer(ContractBackend)("verifyBackendContract in a layer", (provided) => {
  provided.effect("MemoryBackend satisfies the contract", () =>
    Backend.use((backend) => BackendContract.verifyBackendContract(backend))
  );
});

layer(BackendContract.layerParkGates)("verifyBackendContract", (it) => {
  it.effect("MemoryBackend satisfies the contract", () =>
    BackendContract.makeMemoryHandlers.pipe(
      Effect.flatMap(MemoryBackend.make),
      Effect.flatMap((backend) => BackendContract.verifyBackendContract(backend))
    )
  );

  it.effect("catches a backend that re-applies acknowledged mutations", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      // Renumbering incoming mutation ids defeats idempotent skip: every
      // delivery applies, acknowledged or not.
      let sequence = 0;
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          inner.applyMutations(
            context,
            mutations.map((m) => ({ ...m, mutationId: MutationId.make(++sequence) }))
          ),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("idempotency");
    })
  );

  it.effect("catches a backend that accepts mutation-id gaps", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
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
                const mutationId = MutationId.make(
                  m.mutationId > last + 1 ? last + 1 : m.mutationId
                );
                running[m.clientId] = MutationId.make(Math.max(last, mutationId));
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
      const broken = yield* MemoryBackend.make(
        yield* withoutHandler(BackendContract.failAlways.name)
      );
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
      const broken = yield* MemoryBackend.make(
        yield* withoutHandler(BackendContract.writeThenFail.name)
      );
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("discards");
      expect(failure.message).toContain("not registered");
    })
  );

  it.effect("detects an unregistered mutator by its typed cause, whatever the message says", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(
        yield* withoutHandler(BackendContract.writeThenFail.name)
      );
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
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
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

  // Gates are per service instance: a backend whose handlers park at other gates
  // than the contract opens never parks, and rule 11 says so.
  it.effect("fails rule 11 when the handlers park at another ParkGates instance", () =>
    Effect.gen(function* () {
      const elsewhere = yield* BackendContract.makeParkGates;
      const handlers = yield* BackendContract.makeMemoryHandlers.pipe(
        Effect.provideService(BackendContract.ParkGates, elsewhere)
      );
      const backend = yield* MemoryBackend.make(handlers);
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(backend));
      expect(failure.rule).toContain("guarantee 1");
      expect(failure.message).toContain("finished without reaching park()");
    })
  );

  it.effect("catches a backend whose count-up read escapes the commit's validation", () =>
    Effect.gen(function* () {
      // The handler reads the counter from a snapshot the wrapper takes when the
      // call starts, not through the stage. MemoryBackend's read validation never
      // sees that read, so a peer group's commit between the read and the write is
      // overwritten: a lost update across client groups (rule 11).
      const snapshots = MutableHashMap.empty<string, number>();
      const gates = yield* BackendContract.ParkGates;
      const staleCount: MemoryBackend.BackendHandler = (raw, writer, context) => {
        const args = Schema.decodeUnknownSync(BackendContract.countUp.args)(raw);
        return Effect.gen(function* () {
          const seen = Option.getOrElse(
            MutableHashMap.get(snapshots, context.clientGroupId),
            () => 0
          );
          yield* gates.park(args.gate);
          yield* writer.put(args.collection, args.id, { n: seen + 1 });
        });
      };
      const inner = yield* MemoryBackend.make({
        ...(yield* BackendContract.makeMemoryHandlers),
        [BackendContract.countUp.name]: staleCount,
      });
      const broken: Backend = {
        ...inner,
        applyMutations: (context, mutations) =>
          Effect.gen(function* () {
            const [row] = yield* inner.getRows(context, "__contract", [RowId.make("race")]);
            MutableHashMap.set(snapshots, context.clientGroupId, decodeCounter(row?.value)?.n ?? 0);
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
      const inner = yield* MemoryBackend.make(
        yield* withoutHandler(BackendContract.writeThenFail.name)
      );
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

  it.effect("passes a backend whose evaluateMany is per-subset evaluate", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      const batched: Backend = {
        ...inner,
        evaluateMany: (context, subsets) =>
          Effect.forEach(subsets, (subset) => inner.evaluate(context, subset), { concurrency: 1 }),
      };
      yield* BackendContract.verifyBackendContract(batched);
    })
  );

  it.effect("catches a backend whose evaluateMany disagrees with evaluate", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      // Drops each subset's last entry: right for an empty subset, wrong otherwise.
      const broken: Backend = {
        ...inner,
        evaluateMany: (context, subsets) =>
          Effect.forEach(
            subsets,
            (subset) =>
              inner.evaluate(context, subset).pipe(Effect.map((entries) => entries.slice(0, -1))),
            { concurrency: 1 }
          ),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(broken));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("evaluateMany");
    })
  );
  it.effect("catches a backend whose evaluateCounted reports the window's size as the total", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      const windowed: Backend = {
        ...inner,
        evaluateCounted: (context, subsets) =>
          Effect.forEach(
            subsets,
            (subset) =>
              inner
                .evaluate(context, subset)
                .pipe(Effect.map((entries) => ({ entries, total: entries.length }))),
            { concurrency: 1 }
          ),
      };
      const failure = yield* Effect.flip(BackendContract.verifyBackendContract(windowed));
      expect(failure._tag).toBe("ContractViolation");
      expect(failure.rule).toContain("evaluateCounted");
      expect(failure.message).toContain("total");
    })
  );
});

layer(BackendContract.layerParkGates)("Backend.evaluateAll", (it) => {
  it.effect("asks evaluate per subset when the backend has no evaluateMany", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      const asked: Array<string> = [];
      const counted: Backend = {
        ...inner,
        evaluate: (context, subset) => {
          asked.push(subset.collection);
          return inner.evaluate(context, subset);
        },
      };
      const lists = yield* evaluateAll(counted, { clientGroupId: ClientGroupId.make("g") }, [
        Subset.make({ collection: "a" }),
        Subset.make({ collection: "b" }),
      ]);
      expect(lists).toEqual([[], []]);
      expect(asked).toEqual(["a", "b"]);
      expect(yield* evaluateAll(counted, { clientGroupId: ClientGroupId.make("g") }, [])).toEqual(
        []
      );
      expect(asked).toEqual(["a", "b"]);
    })
  );

  it.effect("fails when evaluateMany returns a list count other than the subsets'", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      const short: Backend = { ...inner, evaluateMany: () => Effect.succeed([]) };
      const error = yield* Effect.flip(
        evaluateAll(short, { clientGroupId: ClientGroupId.make("g") }, [
          Subset.make({ collection: "a" }),
        ])
      );
      expect(error.message).toContain("0 entry lists for 1 subsets");
    })
  );
});

layer(BackendContract.layerParkGates)("Backend totals", (it) => {
  const seeded = Effect.fnUntraced(function* () {
    const backend = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
    yield* Effect.forEach(
      [1, 2, 3, 4, 5],
      (n) =>
        backend.applyMutations({ clientGroupId: ClientGroupId.make("g") }, [
          {
            clientId: "c",
            mutationId: MutationId.make(n),
            mutator: BackendContract.putRow.name,
            args: { collection: "items", id: `i-${n}`, value: { id: `i-${n}`, n } },
            createdAt: 0,
          },
        ]),
      { concurrency: 1, discard: true }
    );
    return backend;
  });
  const window = Subset.make({
    collection: "items",
    orderBy: [{ field: "n", direction: "asc" }],
    limit: 2,
  });

  it.effect("the memory backend counts the collection, not the window", () =>
    Effect.gen(function* () {
      const backend = yield* seeded();
      const [answer] = yield* evaluateCountedAll(
        backend,
        { clientGroupId: ClientGroupId.make("g") },
        [window]
      );
      expect(answer?.entries.map((entry) => entry.id)).toEqual(["i-1", "i-2"]);
      expect(answer?.total).toBe(5);
      expect(
        yield* totalsOf(backend, { clientGroupId: ClientGroupId.make("g") }, [window])
      ).toEqual([5]);
    })
  );

  it.effect(
    "without evaluateCounted a pull's evaluation has no totals, and totalsOf counts the unwindowed subset",
    () =>
      Effect.gen(function* () {
        const backend: Backend = { ...(yield* seeded()), evaluateCounted: undefined };
        const [answer] = yield* evaluateCountedAll(
          backend,
          { clientGroupId: ClientGroupId.make("g") },
          [window]
        );
        expect(answer?.entries).toHaveLength(2);
        expect(answer?.total).toBeUndefined();
        expect(
          yield* totalsOf(backend, { clientGroupId: ClientGroupId.make("g") }, [window])
        ).toEqual([5]);
      })
  );

  it.effect("fails when evaluateCounted returns an answer count other than the subsets'", () =>
    Effect.gen(function* () {
      const inner = yield* MemoryBackend.make(yield* BackendContract.makeMemoryHandlers);
      const short: Backend = { ...inner, evaluateCounted: () => Effect.succeed([]) };
      const error = yield* Effect.flip(
        evaluateCountedAll(short, { clientGroupId: ClientGroupId.make("g") }, [
          Subset.make({ collection: "a" }),
        ])
      );
      expect(error.message).toContain("evaluateCounted returned 0 entry lists for 1 subsets");
    })
  );
});
