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
import * as FilterCorpus from "./FilterCorpus.js";
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

// ─── Verification harness ────────────────────────────────────────────────────

/** Options for {@link verifyBackendContract}. */
export interface VerifyOptions {
  /** Base name for the collections written during verification. */
  readonly collection?: string;
  readonly clientGroupId?: string;
}

interface EvalRow {
  readonly rank: number;
  /**
   * A string discriminator rather than a boolean: SQL backends store what
   * their columns can hold, and e.g. SQLite has no boolean type — the
   * contract exercises predicate evaluation, not a value-encoding
   * convention (ADR-0014 keeps values opaque).
   */
  readonly tag: "keep" | "drop";
}

/**
 * What every rule shares: the backend under test, the fixed sync context and
 * client id, the two contract collections, the mutation constructors, and
 * the helpers that turn a backend call into a `ContractViolation`.
 */
interface Harness {
  readonly backend: Backend;
  readonly context: SyncContext;
  readonly clientId: string;
  /** The collection the write rules target. */
  readonly rows: string;
  /** The collection rule 6 evaluates subsets over. */
  readonly evalRows: string;
  readonly check: (
    rule: string,
    condition: boolean,
    message: string
  ) => Effect.Effect<void, ContractViolation>;
  /** Run backend calls that the contract requires to succeed. */
  readonly expectOk: <A>(
    rule: string,
    effect: Effect.Effect<A, BackendError>
  ) => Effect.Effect<A, ContractViolation>;
  /** Run backend calls that the contract requires to fail. */
  readonly expectFail: (
    rule: string,
    effect: Effect.Effect<unknown, BackendError>,
    what: string
  ) => Effect.Effect<void, ContractViolation>;
  /** The contract client's last mutation id in the verification group. */
  readonly lastIdOf: (rule: string) => Effect.Effect<number, ContractViolation>;
  readonly mutation: (mutationId: number, mutator: string, args: unknown) => Mutation;
  readonly put: (mutationId: number, collection: string, id: string, value: unknown) => Mutation;
  readonly reject: (mutationId: number, collection: string, id: string) => Mutation;
}

const makeHarness = (backend: Backend, options: VerifyOptions | undefined): Harness => {
  const rows = options?.collection ?? "__contract";
  const context: SyncContext = { clientGroupId: options?.clientGroupId ?? "__contract-group" };
  const clientId = "contract-client";

  const violation = (rule: string, message: string) => new ContractViolation({ rule, message });
  const check: Harness["check"] = (rule, condition, message) =>
    condition ? Effect.void : Effect.fail(violation(rule, message));
  const expectOk: Harness["expectOk"] = (rule, effect) =>
    effect.pipe(
      Effect.mapError((error) => violation(rule, `Backend failed unexpectedly: ${error.message}`))
    );
  const expectFail: Harness["expectFail"] = (rule, effect, what) =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit) => check(rule, exit._tag === "Failure", `Expected failure: ${what}`))
    );
  const mutation: Harness["mutation"] = (mutationId, mutator, args) => ({
    clientId,
    mutationId,
    mutator,
    args,
    createdAt: Date.now(),
  });

  return {
    backend,
    context,
    clientId,
    rows,
    evalRows: `${rows}_eval`,
    check,
    expectOk,
    expectFail,
    lastIdOf: (rule) =>
      expectOk(rule, backend.lastMutationIds(context)).pipe(
        Effect.map((ids) => ids[clientId] ?? 0)
      ),
    mutation,
    put: (mutationId, collection, id, value) =>
      mutation(mutationId, putRow.name, { collection, id, value }),
    reject: (mutationId, collection, id) =>
      mutation(mutationId, rejectAlways.name, { collection, id }),
  };
};

/** One numbered rule of the contract, run against the shared harness. */
type Rule = (h: Harness) => Effect.Effect<void, ContractViolation>;

// ─── Rules ───────────────────────────────────────────────────────────────────

/** 1. In-order application bumps lastMutationIds and applies effects. */
const rule1InOrderApplication: Rule = ({
  backend,
  context,
  clientId,
  rows,
  check,
  expectOk,
  put,
}) =>
  Effect.gen(function* () {
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
  });

/** 2. Idempotent skip: an already-applied mutation id has no effect. */
const rule2IdempotentSkip: Rule = ({ backend, context, clientId, rows, check, expectOk, put }) =>
  Effect.gen(function* () {
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
    // Field-level check, not exact value equality: how a backend encodes a
    // row (extra columns, an id echoed into the value) is its own business
    // (ADR-0014 keeps values opaque); the contract only demands the replay
    // did not re-execute.
    yield* check(
      rule,
      (b?.value as { n?: number } | undefined)?.n === 2,
      `Replaying mutation 2 must not re-execute its effects (row "b" became ${JSON.stringify(b?.value)})`
    );
  });

/** 3. Gap rejection: a mutation id beyond last+1 is an error. */
const rule3GapRejection: Rule = ({
  backend,
  context,
  rows,
  check,
  expectOk,
  expectFail,
  lastIdOf,
  put,
}) =>
  Effect.gen(function* () {
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
  });

/** 4. Atomicity: a failed mutator bumps nothing. */
const rule4AtomicBump: Rule = ({ backend, context, check, expectFail, lastIdOf, mutation }) =>
  Effect.gen(function* () {
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
  });

/** 5. Authoritative writes change row versions. */
const rule5VersionBump: Rule = ({ backend, context, rows, check, expectOk, put }) =>
  Effect.gen(function* () {
    const rule = "changes the row version on every authoritative write";
    const [before] = yield* expectOk(rule, backend.getRows(context, rows, ["a"]));
    yield* expectOk(rule, backend.applyMutations(context, [put(3, rows, "a", { n: 3 })]));
    const [after] = yield* expectOk(rule, backend.getRows(context, rows, ["a"]));
    yield* check(
      rule,
      before !== undefined && after !== undefined && before.version !== after.version,
      `Rewriting row "a" must change its version (was ${before?.version}, now ${after?.version})`
    );
  });

/**
 * `evaluate` must return exactly the ids `Subset.apply` returns over
 * `reference`, order included. Returns the expected ids so a caller can
 * page on from them; `describe` renders the violation from both id lists.
 */
const expectEvaluation = (
  { backend, context, check, expectOk }: Harness,
  rule: string,
  reference: ReadonlyArray<Subset.Row>,
  subset: Subset.Subset,
  describe: (expected: ReadonlyArray<string>, evaluated: ReadonlyArray<string>) => string
) =>
  Effect.gen(function* () {
    const expected = Subset.apply(reference, subset).map((row) => row.id);
    const evaluated = (yield* expectOk(rule, backend.evaluate(context, subset))).map(
      (entry) => entry.id
    );
    yield* check(
      rule,
      JSON.stringify(evaluated) === JSON.stringify(expected),
      describe(expected, evaluated)
    );
    return expected;
  });

/** The five hand-picked rows rule 6 starts from, in insertion order. */
const evalSeed: ReadonlyArray<readonly [string, EvalRow]> = [
  ["e1", { rank: 10, tag: "keep" }],
  ["e2", { rank: 40, tag: "keep" }],
  ["e3", { rank: 20, tag: "drop" }],
  ["e4", { rank: 30, tag: "keep" }],
  ["e5", { rank: 50, tag: "keep" }],
];

/**
 * The generated half of rule 6: a small corpus (issue #153) over the same two
 * columns, so every backend inherits the check for every operator in the
 * core: `evaluate` must return exactly what `Subset.apply` returns over the
 * same rows, order included, for random predicates, order terms, and
 * limits. NULL/absent values and astral text are on: ADR-0028 makes
 * Postgres normative for both and the JS evaluator is exact there (#155),
 * so a backend whose storage treats NULL two-valued, orders NULL first
 * ascending, or compares text by UTF-16 code unit fails here by design.
 * String order is code-point order (ADR-0028 rule (c)): the `tag` pool
 * mixes case and accents, so a backend whose text column carries a locale
 * collation fails too — the contract requires `COLLATE "C"` (Postgres) or
 * `BINARY` (SQLite).
 */
const generatedCorpus = (
  h: Harness,
  rule: string,
  reference: ReadonlyArray<Subset.Row>,
  nextMutationId: number
) =>
  Effect.gen(function* () {
    const columns: ReadonlyArray<FilterCorpus.Column> = [
      { name: "rank", kind: "integer" },
      { name: "tag", kind: "text" },
    ];
    const options: FilterCorpus.CorpusOptions = { nulls: true, astral: true };
    const corpus = yield* FilterCorpus.generateCorpus({
      seed: FilterCorpus.DEFAULT_SEED,
      columns,
      // The guaranteed pool sweep plus a handful of random rows.
      rows: FilterCorpus.minimumRows(columns, options) + 10,
      predicates: 40,
      orderBys: 40,
      ...options,
    });
    const corpusRows = corpus.rows.map((row) => ({ id: `c-${row.id}`, value: row.value }));
    yield* h.expectOk(
      rule,
      h.backend.applyMutations(
        h.context,
        corpusRows.map((row, index) => h.put(nextMutationId + index, h.evalRows, row.id, row.value))
      )
    );
    const all = [...reference, ...corpusRows];
    for (const [index, where] of corpus.predicates.entries()) {
      const subset = Subset.make({
        collection: h.evalRows,
        where,
        orderBy: corpus.orderBys[index % corpus.orderBys.length],
        ...(index % 3 === 0 ? { limit: 1 + (index % 7) } : {}),
      });
      yield* expectEvaluation(h, rule, all, subset, (expected, evaluated) =>
        FilterCorpus.formatDisagreement({
          seed: corpus.seed,
          subject: `generated subset ${index}${subset.limit !== undefined ? ` (limit ${subset.limit})` : ""}`,
          predicate: where,
          orderBy: subset.orderBy,
          rows: all,
          results: { "Subset.apply": expected, "backend.evaluate": evaluated },
          reproduce: "the contract corpus uses FilterCorpus.DEFAULT_SEED, not the environment",
        })
      );
    }
  });

/** 6. Evaluate matches the reference subset semantics (Subset.apply). */
const rule6ReferenceSemantics: Rule = (h) =>
  Effect.gen(function* () {
    const rule = "evaluates subsets with the reference semantics (Subset.apply)";
    yield* h.expectOk(
      rule,
      h.backend.applyMutations(
        h.context,
        evalSeed.map(([id, value], index) => h.put(4 + index, h.evalRows, id, value))
      )
    );
    const reference = evalSeed.map(([id, value]) => ({ id, value }));

    const limited = Subset.make({
      collection: h.evalRows,
      where: Predicate.eq("tag", "keep"),
      orderBy: [{ field: "rank", direction: "desc" }],
      limit: 2,
    });
    const expectedLimited = yield* expectEvaluation(
      h,
      rule,
      reference,
      limited,
      (expected, evaluated) =>
        `where+orderBy+limit: expected ${JSON.stringify(expected)}, got ${JSON.stringify(evaluated)}`
    );

    const paged = Subset.make({
      collection: h.evalRows,
      where: Predicate.eq("tag", "keep"),
      orderBy: [{ field: "rank", direction: "desc" }],
      limit: 2,
      cursor: expectedLimited[expectedLimited.length - 1],
    });
    yield* expectEvaluation(
      h,
      rule,
      reference,
      paged,
      (expected, evaluated) =>
        `cursor page: expected ${JSON.stringify(expected)}, got ${JSON.stringify(evaluated)}`
    );

    yield* generatedCorpus(h, rule, reference, 4 + evalSeed.length);
  });

/** 7. getRows omits missing ids. */
const rule7OmitsMissingIds: Rule = ({ backend, context, rows, check, expectOk }) =>
  Effect.gen(function* () {
    const rule = "omits missing ids from getRows";
    const fetched = yield* expectOk(rule, backend.getRows(context, rows, ["a", "does-not-exist"]));
    yield* check(
      rule,
      fetched.length === 1 && fetched[0]?.id === "a",
      `Expected exactly row "a", got ${JSON.stringify(fetched.map((row) => row.id))}`
    );
  });

/** 8. Client groups are isolated. */
const rule8ClientGroupIsolation: Rule = ({ backend, context, clientId, check, expectOk }) =>
  Effect.gen(function* () {
    const rule = "isolates lastMutationIds between client groups";
    const other: SyncContext = { clientGroupId: `${context.clientGroupId}-other` };
    const ids = yield* expectOk(rule, backend.lastMutationIds(other));
    yield* check(
      rule,
      (ids[clientId] ?? 0) === 0,
      `A fresh client group must not see another group's mutation ids (got ${ids[clientId]})`
    );
  });

/**
 * 9. Permanent rejection: the poison mutation is acknowledged (its id
 *    bumped) with no effects, and the mutation queued behind it applies.
 */
const rule9PermanentRejection: Rule = (h) =>
  Effect.gen(function* () {
    const { backend, context, clientId, rows, check, expectOk } = h;
    const rule = "acknowledges a permanent rejection without effects and applies those behind it";
    const startId = yield* h.lastIdOf(rule);
    const result = yield* expectOk(
      rule,
      backend.applyMutations(context, [
        h.reject(startId + 1, rows, "poison"),
        h.put(startId + 2, rows, "behind", { n: 1 }),
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
  });

/** The contract, in the order the rules build on one another's state. */
const rules: ReadonlyArray<Rule> = [
  rule1InOrderApplication,
  rule2IdempotentSkip,
  rule3GapRejection,
  rule4AtomicBump,
  rule5VersionBump,
  rule6ReferenceSemantics,
  rule7OmitsMissingIds,
  rule8ClientGroupIsolation,
  rule9PermanentRejection,
];

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Verify a backend against the contract. The backend must have the contract
 * mutators registered and the contract collections empty.
 */
export const verifyBackendContract = (
  backend: Backend,
  options?: VerifyOptions
): Effect.Effect<void, ContractViolation> => {
  const harness = makeHarness(backend, options);
  return Effect.forEach(rules, (rule) => rule(harness), { discard: true });
};
