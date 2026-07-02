/**
 * BackendContract
 *
 * The executable specification of the Backend contract (ADR-0009).
 * `verifyBackendContract` drives an implementation through the guarantees
 * documented in Backend.ts — in-order application, idempotent skip, gap
 * rejection, bump-atomic-with-effects, version-bumping writes, reference
 * subset-evaluation semantics (Subset.apply), and client-group isolation —
 * failing with a ContractViolation naming the broken rule.
 *
 * The backend under test must register the contract mutators (the
 * definitions below; `memoryHandlers` is the ready-made registration for
 * MemoryBackend-style backends). Verification writes rows into the
 * configured contract collections, so run it against disposable instances.
 */

import { Data, Effect, Schema } from "effect";
import type { Backend, SyncContext } from "./Backend.js";
import { BackendError, MutationRejected } from "./Errors.js";
import * as MemoryBackend from "./MemoryBackend.js";
import * as Mutator from "./Mutator.js";
import * as Predicate from "./Predicate.js";
import type { Mutation } from "./Protocol.js";
import * as Subset from "./Subset.js";

/** A backend broke one of the contract's guarantees. */
export class ContractViolation extends Data.TaggedError("ContractViolation")<{
  readonly rule: string;
  readonly message: string;
}> {}

// ─── Contract mutators ───────────────────────────────────────────────────────

/** Write one row. */
export const putRow = Mutator.make(
  "contract/put",
  Schema.Struct({ collection: Schema.String, id: Schema.String, value: Schema.Unknown })
);

/** Delete one row. */
export const delRow = Mutator.make(
  "contract/del",
  Schema.Struct({ collection: Schema.String, id: Schema.String })
);

/**
 * Fails transiently — probes that a `BackendError` aborts the batch and the
 * mutation-id bump is atomic with effects (no bump on abort).
 */
export const failAlways = Mutator.make("contract/fail", Schema.Struct({}));

/**
 * Writes a row and then rejects permanently — probes that a `MutationRejected`
 * bumps the id *without* leaving effects (the staged write must roll back).
 */
export const rejectAlways = Mutator.make(
  "contract/reject",
  Schema.Struct({ collection: Schema.String, id: Schema.String })
);

/** Ready-made authoritative handlers for MemoryBackend-style registration. */
export const memoryHandlers: Record<string, MemoryBackend.BackendHandler> =
  MemoryBackend.validatedHandlers([
    MemoryBackend.handler(putRow, (args, writer) =>
      writer.put(args.collection, args.id, args.value)
    ),
    MemoryBackend.handler(delRow, (args, writer) => writer.del(args.collection, args.id)),
    MemoryBackend.handler(failAlways, () =>
      Effect.fail(new BackendError({ message: "contract/fail always fails" }))
    ),
    MemoryBackend.handler(rejectAlways, (args, writer) =>
      writer
        .put(args.collection, args.id, { poison: true })
        .pipe(
          Effect.andThen(
            Effect.fail(new MutationRejected({ reason: "contract/reject always rejects" }))
          )
        )
    ),
  ]);

// ─── Verification ────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Base name for the collections written during verification. */
  readonly collection?: string;
  readonly clientGroupId?: string;
}

interface EvalRow {
  readonly rank: number;
  readonly keep: boolean;
}

/**
 * Verify a backend against the contract. The backend must have the contract
 * mutators registered and the contract collections empty.
 */
export const verifyBackendContract = (
  backend: Backend,
  options?: VerifyOptions
): Effect.Effect<void, ContractViolation> => {
  const rows = options?.collection ?? "__contract";
  const evalRows = `${rows}_eval`;
  const context: SyncContext = { clientGroupId: options?.clientGroupId ?? "__contract-group" };
  const clientId = "contract-client";

  const violation = (rule: string, message: string) => new ContractViolation({ rule, message });
  const check = (rule: string, condition: boolean, message: string) =>
    condition ? Effect.void : Effect.fail(violation(rule, message));

  const mutation = (mutationId: number, mutator: string, args: unknown): Mutation => ({
    clientId,
    mutationId,
    mutator,
    args,
    createdAt: Date.now(),
  });
  const put = (mutationId: number, collection: string, id: string, value: unknown) =>
    mutation(mutationId, putRow.name, { collection, id, value });
  const reject = (mutationId: number, collection: string, id: string) =>
    mutation(mutationId, rejectAlways.name, { collection, id });

  /** Run backend calls that the contract requires to succeed. */
  const expectOk = <A>(rule: string, effect: Effect.Effect<A, BackendError>) =>
    effect.pipe(
      Effect.mapError((error) => violation(rule, `Backend failed unexpectedly: ${error.message}`))
    );
  /** Run backend calls that the contract requires to fail. */
  const expectFail = (rule: string, effect: Effect.Effect<unknown, BackendError>, what: string) =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit) => check(rule, exit._tag === "Failure", `Expected failure: ${what}`))
    );

  const lastIdOf = (rule: string) =>
    expectOk(rule, backend.lastMutationIds(context)).pipe(Effect.map((ids) => ids[clientId] ?? 0));

  return Effect.gen(function* () {
    // 1. In-order application bumps lastMutationIds and applies effects.
    {
      const rule = "applies mutations in order and bumps lastMutationIds";
      const result = yield* expectOk(
        rule,
        backend.applyMutations(context, [put(1, rows, "a", { n: 1 }), put(2, rows, "b", { n: 2 })])
      );
      yield* check(
        rule,
        result.lastMutationIds[clientId] === 2,
        `Expected lastMutationIds["${clientId}"] = 2, got ${result.lastMutationIds[clientId]}`
      );
      const fetched = yield* expectOk(rule, backend.getRows(context, rows, ["a", "b"]));
      yield* check(rule, fetched.length === 2, `Expected 2 rows back, got ${fetched.length}`);
      yield* check(
        rule,
        fetched.every((row) => row.version !== undefined && row.version !== null),
        "Every row must carry a row version"
      );
    }

    // 2. Idempotent skip: an already-applied mutation id has no effect.
    {
      const rule = "skips already-applied mutation ids (idempotency)";
      const result = yield* expectOk(
        rule,
        backend.applyMutations(context, [put(2, rows, "b", { n: 99 })])
      );
      yield* check(
        rule,
        result.lastMutationIds[clientId] === 2,
        `Replaying mutation 2 must keep lastMutationId at 2, got ${result.lastMutationIds[clientId]}`
      );
      const [b] = yield* expectOk(rule, backend.getRows(context, rows, ["b"]));
      yield* check(
        rule,
        JSON.stringify(b?.value) === JSON.stringify({ n: 2 }),
        `Replaying mutation 2 must not re-execute its effects (row "b" became ${JSON.stringify(b?.value)})`
      );
    }

    // 3. Gap rejection: a mutation id beyond last+1 is an error.
    {
      const rule = "rejects mutation-id gaps";
      yield* expectFail(
        rule,
        backend.applyMutations(context, [put(4, rows, "c", { n: 4 })]),
        "mutation id 4 after lastMutationId 2"
      );
      yield* check(
        rule,
        (yield* lastIdOf(rule)) === 2,
        "A rejected gap must not bump lastMutationId"
      );
      const fetched = yield* expectOk(rule, backend.getRows(context, rows, ["c"]));
      yield* check(rule, fetched.length === 0, "A rejected gap must not apply effects");
    }

    // 4. Atomicity: a failed mutator bumps nothing.
    {
      const rule = "keeps the lastMutationId bump atomic with mutator effects";
      yield* expectFail(
        rule,
        backend.applyMutations(context, [mutation(3, failAlways.name, {})]),
        "the contract/fail mutator"
      );
      yield* check(
        rule,
        (yield* lastIdOf(rule)) === 2,
        "A failed mutator must not bump lastMutationId"
      );
    }

    // 5. Authoritative writes change row versions.
    {
      const rule = "changes the row version on every authoritative write";
      const [before] = yield* expectOk(rule, backend.getRows(context, rows, ["a"]));
      yield* expectOk(rule, backend.applyMutations(context, [put(3, rows, "a", { n: 3 })]));
      const [after] = yield* expectOk(rule, backend.getRows(context, rows, ["a"]));
      yield* check(
        rule,
        before !== undefined && after !== undefined && before.version !== after.version,
        `Rewriting row "a" must change its version (was ${before?.version}, now ${after?.version})`
      );
    }

    // 6. Evaluate matches the reference subset semantics (Subset.apply).
    {
      const rule = "evaluates subsets with the reference semantics (Subset.apply)";
      const seed: ReadonlyArray<readonly [string, EvalRow]> = [
        ["e1", { rank: 10, keep: true }],
        ["e2", { rank: 40, keep: true }],
        ["e3", { rank: 20, keep: false }],
        ["e4", { rank: 30, keep: true }],
        ["e5", { rank: 50, keep: true }],
      ];
      yield* expectOk(
        rule,
        backend.applyMutations(
          context,
          seed.map(([id, value], index) => put(4 + index, evalRows, id, value))
        )
      );
      const reference = seed.map(([id, value]) => ({ id, value }));

      const limited = Subset.make({
        collection: evalRows,
        where: Predicate.eq("keep", true),
        orderBy: [{ field: "rank", direction: "desc" }],
        limit: 2,
      });
      const expectedLimited = Subset.apply(reference, limited).map((row) => row.id);
      const evaluatedLimited = (yield* expectOk(rule, backend.evaluate(context, limited))).map(
        (entry) => entry.id
      );
      yield* check(
        rule,
        JSON.stringify(evaluatedLimited) === JSON.stringify(expectedLimited),
        `where+orderBy+limit: expected ${JSON.stringify(expectedLimited)}, got ${JSON.stringify(evaluatedLimited)}`
      );

      const paged = Subset.make({
        collection: evalRows,
        where: Predicate.eq("keep", true),
        orderBy: [{ field: "rank", direction: "desc" }],
        limit: 2,
        cursor: expectedLimited[expectedLimited.length - 1],
      });
      const expectedPaged = Subset.apply(reference, paged).map((row) => row.id);
      const evaluatedPaged = (yield* expectOk(rule, backend.evaluate(context, paged))).map(
        (entry) => entry.id
      );
      yield* check(
        rule,
        JSON.stringify(evaluatedPaged) === JSON.stringify(expectedPaged),
        `cursor page: expected ${JSON.stringify(expectedPaged)}, got ${JSON.stringify(evaluatedPaged)}`
      );
    }

    // 7. getRows omits missing ids.
    {
      const rule = "omits missing ids from getRows";
      const fetched = yield* expectOk(
        rule,
        backend.getRows(context, rows, ["a", "does-not-exist"])
      );
      yield* check(
        rule,
        fetched.length === 1 && fetched[0]?.id === "a",
        `Expected exactly row "a", got ${JSON.stringify(fetched.map((row) => row.id))}`
      );
    }

    // 8. Client groups are isolated.
    {
      const rule = "isolates lastMutationIds between client groups";
      const other: SyncContext = { clientGroupId: `${context.clientGroupId}-other` };
      const ids = yield* expectOk(rule, backend.lastMutationIds(other));
      yield* check(
        rule,
        (ids[clientId] ?? 0) === 0,
        `A fresh client group must not see another group's mutation ids (got ${ids[clientId]})`
      );
    }

    // 9. Permanent rejection: the poison mutation is acknowledged (its id
    //    bumped) with no effects, and the mutation queued behind it applies.
    {
      const rule = "acknowledges a permanent rejection without effects and applies those behind it";
      const startId = yield* lastIdOf(rule);
      const result = yield* expectOk(
        rule,
        backend.applyMutations(context, [
          reject(startId + 1, rows, "poison"),
          put(startId + 2, rows, "behind", { n: 1 }),
        ])
      );
      yield* check(
        rule,
        result.lastMutationIds[clientId] === startId + 2,
        `A rejection must still bump lastMutationId (expected ${startId + 2}, got ${result.lastMutationIds[clientId]})`
      );
      yield* check(
        rule,
        (result.rejected ?? []).some(
          (entry) => entry.clientId === clientId && entry.mutationId === startId + 1
        ),
        "The rejected mutation must appear in the result's `rejected` list"
      );
      const poison = yield* expectOk(rule, backend.getRows(context, rows, ["poison"]));
      yield* check(
        rule,
        poison.length === 0,
        "A rejected mutation must leave no effects (its staged write must roll back)"
      );
      const behind = yield* expectOk(rule, backend.getRows(context, rows, ["behind"]));
      yield* check(
        rule,
        behind.length === 1,
        "A mutation queued behind a rejected one must still apply in the same push"
      );
    }
  });
};
