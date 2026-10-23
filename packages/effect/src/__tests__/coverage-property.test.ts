/**
 * Coverage soundness as a property (issue #162, ADR-0029 section 3): for
 * generated `(subscribed, requested)` window pairs over the #153 corpus
 * generators and random rows, whenever `Coverage.covers` says the
 * subscription covers the request, evaluating the request over only the
 * rows the subscription holds is exact — the same ids in the same order as
 * evaluating it over every row. The converse is not claimed: a pair the
 * syntactic rule rejects may still agree (a false negative costs a round
 * trip, never wrong data), and the strict window is pinned: a windowed
 * subscription (a limit, a cursor, or both) never covers a strictly
 * narrower predicate.
 *
 * Seeded through Effect's `Random.withSeed`; `LEGATION_CORPUS_SEED`
 * overrides the seed to reproduce a failure.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Coverage from "../Coverage.js";
import * as FilterCorpus from "../FilterCorpus.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import { defined } from "./defined.js";

const seed = FilterCorpus.resolveSeed(process.env["LEGATION_CORPUS_SEED"]);
/** Rows in the generated set (the pinned sweep plus random rows). */
const ROWS = 64;
/** Conjunct-built pairs per run. */
const TRIALS = 500;

const int = (max: number): Effect.Effect<number> =>
  Random.nextIntBetween(0, max, { halfOpen: true });
const chance = (p: number): Effect.Effect<boolean> => Effect.map(Random.next, (roll) => roll < p);

interface Pair {
  readonly subscribed: Subset.Subset;
  readonly requested: Subset.Subset;
}

interface Window {
  readonly orderBy: ReadonlyArray<Subset.OrderBy>;
  readonly limit?: number;
  readonly cursor?: string;
}

const ids = (rows: ReadonlyArray<Subset.Row>): ReadonlyArray<string> => rows.map((row) => row.id);

const conjunctKeys = (subset: Subset.Subset): ReadonlyArray<string> =>
  Coverage.canonicalConjuncts(subset.where).map((conjunct) => conjunct.key);

/** Whether `requested`'s conjunct set strictly contains `subscribed`'s. */
const strictlyNarrower = (pair: Pair): boolean => {
  const held = new Set(conjunctKeys(pair.subscribed));
  const wanted = conjunctKeys(pair.requested);
  return wanted.length > held.size && [...held].every((key) => wanted.includes(key));
};

/** The property: local evaluation over the held rows equals evaluation over all rows. */
const exactLocally = (rows: ReadonlyArray<FilterCorpus.CorpusRow>, pair: Pair): boolean => {
  const held = Subset.apply(rows, pair.subscribed);
  const local = ids(Subset.apply(held, pair.requested));
  const truth = ids(Subset.apply(rows, pair.requested));
  return local.length === truth.length && local.every((id, index) => id === truth[index]);
};

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * A window: 1–2 order terms, a limit of 1–24 three times in four, and a
 * cursor at a real row three times in ten — so limit-only, cursor-only,
 * both, and (rarely) an ordered but unwindowed subset all occur.
 */
const generateWindow = (rows: ReadonlyArray<FilterCorpus.CorpusRow>): Effect.Effect<Window> =>
  Effect.gen(function* () {
    const orderBy = yield* FilterCorpus.generateOrderBy();
    const limit = (yield* chance(0.75)) ? 1 + (yield* int(24)) : undefined;
    const withCursor = yield* chance(0.3);
    const cursor = withCursor ? (yield* Random.choice(rows).pipe(Effect.orDie)).id : undefined;
    return {
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  });

/**
 * The request's window relative to the subscription's: independent (usually
 * different), unwindowed, a shorter prefix of the same window, or identical.
 */
const requestedWindowFor = (
  subscribed: Window,
  rows: ReadonlyArray<FilterCorpus.CorpusRow>
): Effect.Effect<Window> =>
  Effect.gen(function* () {
    const roll = yield* int(4);
    if (roll === 0) return yield* generateWindow(rows);
    if (roll === 1) return { orderBy: [] };
    if (roll === 2) return { ...subscribed, limit: 1 + (yield* int(subscribed.limit ?? 24)) };
    return subscribed;
  });

/** 0–2 conjuncts, each a leaf or a shallow junction (an `And` flattens; `Or`/`Not` stay whole). */
const conjuncts = (
  coverage: FilterCorpus.Coverage
): Effect.Effect<ReadonlyArray<Predicate.Predicate>> =>
  Effect.flatMap(int(3), (count) =>
    FilterCorpus.generatePredicate(FilterCorpus.corpusColumns, undefined, coverage, 1).pipe(
      Effect.replicateEffect(count)
    )
  );

/**
 * A pair: the request carries the subscription's conjuncts plus 0–2 extra
 * ones in shuffled order, so subsumption holds by construction and the
 * window decides; the subscription is unwindowed half the time.
 */
const generatePair = (
  rows: ReadonlyArray<FilterCorpus.CorpusRow>,
  coverage: FilterCorpus.Coverage
): Effect.Effect<Pair> =>
  Effect.gen(function* () {
    const base = yield* conjuncts(coverage);
    const extra = yield* conjuncts(coverage);
    const subscribedWindow: Window = (yield* chance(0.5))
      ? { orderBy: [] }
      : yield* generateWindow(rows);
    const requestedWindow = yield* requestedWindowFor(subscribedWindow, rows);
    const shuffled = yield* Random.shuffle([...base, ...extra]);
    return {
      subscribed: Subset.make({
        collection: "corpus",
        where: Predicate.and(...base),
        ...subscribedWindow,
      }),
      requested: Subset.make({
        collection: "corpus",
        where: Predicate.and(...shuffled),
        ...requestedWindow,
      }),
    };
  });

interface Generated {
  readonly rows: ReadonlyArray<FilterCorpus.CorpusRow>;
  readonly pairs: ReadonlyArray<Pair>;
  readonly coverage: FilterCorpus.Coverage;
}

const generate: Effect.Effect<Generated> = Effect.suspend(() => {
  const coverage = FilterCorpus.emptyCoverage();
  return Effect.gen(function* () {
    const rows = yield* FilterCorpus.generateRows(ROWS);
    const pairs = yield* generatePair(rows, coverage).pipe(Effect.replicateEffect(TRIALS));
    return { rows, pairs, coverage };
  }).pipe(Random.withSeed(seed));
});

// ─── Properties ──────────────────────────────────────────────────────────────

describe(`Coverage soundness (seed ${seed}, ${TRIALS} pairs over ${ROWS} rows)`, () => {
  const { rows, pairs, coverage } = Effect.runSync(generate);

  it("if covers(subscribed, requested) then local evaluation over the held subset is exact", () => {
    const covered = pairs.filter((pair) => Coverage.covers(pair.subscribed, pair.requested));
    const uncovered = pairs.filter((pair) => !Coverage.covers(pair.subscribed, pair.requested));
    // A covered pair whose local evaluation is not exact would be a false positive.
    const unsound = covered.filter((pair) => !exactLocally(rows, pair));
    expect(unsound).toEqual([]);
    // Both branches are exercised, and a non-covering pair may still agree:
    // the rule is sound, not complete, and never claims the converse.
    expect(covered.length).toBeGreaterThan(TRIALS / 5);
    expect(uncovered.length).toBeGreaterThan(TRIALS / 5);
    expect(uncovered.filter((pair) => exactLocally(rows, pair)).length).toBeGreaterThan(0);
  });

  it("the generators produce cursor-only, limit-only and cursored-and-limited subscriptions", () => {
    const cursorOnly = pairs.filter(
      (pair) => pair.subscribed.cursor !== undefined && pair.subscribed.limit === undefined
    );
    const limitOnly = pairs.filter(
      (pair) => pair.subscribed.cursor === undefined && pair.subscribed.limit !== undefined
    );
    const both = pairs.filter(
      (pair) => pair.subscribed.cursor !== undefined && pair.subscribed.limit !== undefined
    );
    expect(cursorOnly.length).toBeGreaterThan(0);
    expect(limitOnly.length).toBeGreaterThan(0);
    expect(both.length).toBeGreaterThan(0);
    // A cursor-only subscription covers some request (its own window) and
    // never an unwindowed one: it does not hold the rows before its cursor.
    expect(cursorOnly.some((pair) => Coverage.covers(pair.subscribed, pair.requested))).toBe(true);
    expect(
      cursorOnly.filter(
        (pair) =>
          pair.requested.cursor === undefined && Coverage.covers(pair.subscribed, pair.requested)
      )
    ).toEqual([]);
  });

  it("the verdict is invariant under conjunct order", () => {
    for (const pair of pairs) {
      const members = Coverage.canonicalConjuncts(pair.requested.where).map(
        (conjunct) => conjunct.predicate
      );
      const reversed = { ...pair.requested, where: Predicate.and(...[...members].reverse()) };
      expect(Coverage.covers(pair.subscribed, reversed)).toBe(
        Coverage.covers(pair.subscribed, pair.requested)
      );
    }
  });

  it("a windowed subscription never covers a strictly narrower predicate", () => {
    const narrower = pairs.filter(
      (pair) => Coverage.isWindowed(pair.subscribed) && strictlyNarrower(pair)
    );
    expect(narrower.length).toBeGreaterThan(0);
    expect(narrower.filter((pair) => Coverage.covers(pair.subscribed, pair.requested))).toEqual([]);
  });

  it("the generators reached every conjunct shape", () => {
    expect(coverage.and + coverage.or + coverage.not).toBeGreaterThan(0);
    expect(coverage.in + coverage.nin + coverage.isnull).toBeGreaterThan(0);
  });
});

describe("the harness corpus as subscriptions", () => {
  const corpus = Effect.runSync(FilterCorpus.generateCorpus({ seed }));

  it("every corpus predicate, unwindowed, covers itself under every corpus window", () => {
    for (const [index, where] of corpus.predicates.entries()) {
      const subscribed = Subset.make({ collection: "corpus", where });
      const orderBy = defined(corpus.orderBys[index % corpus.orderBys.length]);
      const requested = Subset.make({
        collection: "corpus",
        where,
        orderBy,
        limit: 1 + (index % 20),
      });
      expect(Coverage.covers(subscribed, requested)).toBe(true);
      expect(exactLocally(corpus.rows, { subscribed, requested })).toBe(true);
    }
  });

  it("every corpus predicate, unwindowed, covers itself conjoined with its neighbour", () => {
    for (const [index, where] of corpus.predicates.entries()) {
      const neighbour = defined(corpus.predicates[(index + 1) % corpus.predicates.length]);
      const subscribed = Subset.make({ collection: "corpus", where });
      const requested = Subset.make({
        collection: "corpus",
        where: Predicate.and(neighbour, where),
        orderBy: defined(corpus.orderBys[index % corpus.orderBys.length]),
      });
      expect(Coverage.covers(subscribed, requested)).toBe(true);
      expect(exactLocally(corpus.rows, { subscribed, requested })).toBe(true);
    }
  });
});

describe("the converse is not claimed", () => {
  it("an implied but structurally different predicate is a (harmless) false negative", () => {
    const rows = Effect.runSync(FilterCorpus.generateRows(ROWS).pipe(Random.withSeed(seed)));
    const subscribed = Subset.make({ collection: "corpus", where: Predicate.gt("i", 5) });
    const requested = Subset.make({ collection: "corpus", where: Predicate.gt("i", 10) });
    expect(Coverage.covers(subscribed, requested)).toBe(false);
    expect(exactLocally(rows, { subscribed, requested })).toBe(true);
  });
});
