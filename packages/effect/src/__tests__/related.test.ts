/**
 * Related tests: declared field-mapping relationships resolved over the local
 * mirror. Registry validation (duplicate + unknown foreign collection), `one`
 * and `many` resolution with incremental re-hydration that leaves the base
 * untouched, `related`'s auto-subscription + scope teardown, and client-side
 * `Predicate.exists` rendering.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema, Scope, Stream, SubscriptionRef } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Collection from "../Collection.js";
import * as Cvr from "../Cvr.js";
import { DuplicateNameError, UnknownCollectionError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Related from "../Related.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Issue {
  readonly id: string;
  readonly title: string;
  readonly authorId: string;
}
interface CommentRow {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
}
interface Person {
  readonly id: string;
  readonly name: string;
}

const IssueSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) as unknown as Schema.Codec<Issue>;
const CommentSchema = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  body: Schema.String,
}) as unknown as Schema.Codec<CommentRow>;
const PersonSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
}) as unknown as Schema.Codec<Person>;

const issuesCollection = Collection.make({
  name: "issues",
  schema: IssueSchema,
  id: (row) => row.id,
  relationships: [
    {
      name: "author",
      kind: "one",
      collection: "people",
      localField: "authorId",
      foreignField: "id",
    },
    {
      name: "comments",
      kind: "many",
      collection: "comments",
      localField: "id",
      foreignField: "issueId",
    },
  ],
});
const commentsCollection = Collection.make({
  name: "comments",
  schema: CommentSchema,
  id: (row) => row.id,
});
const peopleCollection = Collection.make({
  name: "people",
  schema: PersonSchema,
  id: (row) => row.id,
});

const registry = Collection.registry([issuesCollection, commentsCollection, peopleCollection]);

// A generic "set" mutator per collection: put the row value at its id.
const setRow =
  (collection: string) =>
  (args: unknown, writer: { put: (c: string, id: string, v: unknown) => any }) =>
    writer.put(collection, (args as { id: string }).id, args);

const mutators = Mutator.registry([
  { mutator: Mutator.make("issue/set", Schema.Unknown), local: setRow("issues") },
  { mutator: Mutator.make("comment/set", Schema.Unknown), local: setRow("comments") },
  { mutator: Mutator.make("person/set", Schema.Unknown), local: setRow("people") },
]);

const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "issue/set": (args, writer) => Effect.asVoid(writer.put("issues", (args as Issue).id, args)),
  "comment/set": (args, writer) =>
    Effect.asVoid(writer.put("comments", (args as CommentRow).id, args)),
  "person/set": (args, writer) => Effect.asVoid(writer.put("people", (args as Person).id, args)),
};

const authPolicy = Authorization.policy({
  issues: Authorization.allowAll,
  comments: Authorization.allowAll,
  people: Authorization.allowAll,
});

const makeServer: Effect.Effect<ServerHandler, never, Scope.Scope> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, authPolicy),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (handler: ServerHandler, name: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, `group-${name}`);
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: `group-${name}`,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
    return { engine, store };
  });

const issues = Subset.make({ collection: "issues" });

// Seed: one issue authored by p1 with two comments; a second issue with none.
const seed = (engine: ClientEngineModule.ClientEngine) =>
  Effect.gen(function* () {
    yield* engine.mutate("person/set", { id: "p1", name: "Ada" });
    yield* engine.mutate("issue/set", { id: "i1", title: "Bug", authorId: "p1" });
    yield* engine.mutate("issue/set", { id: "i2", title: "Idle", authorId: "p1" });
    yield* engine.mutate("comment/set", { id: "c1", issueId: "i1", body: "first" });
    yield* engine.mutate("comment/set", { id: "c2", issueId: "i1", body: "second" });
    yield* engine.push;
  });

const syncAll = (engine: ClientEngineModule.ClientEngine) =>
  Effect.gen(function* () {
    yield* engine.subscribe(issues);
    yield* engine.subscribe(Subset.make({ collection: "comments" }));
    yield* engine.subscribe(Subset.make({ collection: "people" }));
    yield* engine.pull;
  });

const commentBodies = (row: Related.RelatedRow): ReadonlyArray<string> =>
  (row.related.comments as ReadonlyArray<CommentRow>).map((c) => c.body);

/**
 * Waits on an observer's recorded emissions (not on wall-clock time) until
 * `until` holds, and returns that snapshot. The wait is bounded: past 5 s the
 * test dies with `failure` and what the observer had recorded, rather than
 * running into the test timeout with no diagnostics.
 */
const waitForEmissions = <A>(
  seen: SubscriptionRef.SubscriptionRef<A>,
  until: (emissions: A) => boolean,
  failure: string,
  show: (emissions: A) => unknown = (emissions) => emissions
): Effect.Effect<A> =>
  SubscriptionRef.changes(seen).pipe(
    Stream.filter(until),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.flatMap(SubscriptionRef.get(seen), (emissions) =>
          Effect.die(new Error(`${failure}; saw ${JSON.stringify(show(emissions))}`))
        ),
    })
  );

describe("Collection.registry relationship validation", () => {
  it("throws on a duplicate relationship name within a collection", () => {
    const bad = Collection.make({
      name: "a",
      schema: PersonSchema,
      id: (r) => r.id,
      relationships: [
        { name: "dup", kind: "one", collection: "a", localField: "id", foreignField: "id" },
        { name: "dup", kind: "one", collection: "a", localField: "id", foreignField: "id" },
      ],
    });
    expect(() => Collection.registry([bad])).toThrow(DuplicateNameError);
  });

  it("throws on a relationship pointing at an unknown collection", () => {
    const bad = Collection.make({
      name: "a",
      schema: PersonSchema,
      id: (r) => r.id,
      relationships: [
        { name: "ghost", kind: "one", collection: "nope", localField: "id", foreignField: "id" },
      ],
    });
    expect(() => Collection.registry([bad])).toThrow(UnknownCollectionError);
  });
});

describe("Related.query / observe", () => {
  it.effect("resolves a `one` and a `many` relationship from the mirror", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine);
      yield* syncAll(engine);

      const rows = yield* Related.query(engine, registry, "issues", issues, ["author", "comments"]);
      const i1 = rows.find((r) => r.id === "i1")!;
      expect((i1.related.author as Person).name).toBe("Ada");
      expect(commentBodies(i1)).toEqual(["first", "second"]);
      // The comment-less issue resolves to an empty list, not undefined.
      expect(commentBodies(rows.find((r) => r.id === "i2")!)).toEqual([]);
    })
  );

  // Real-clock: a forked observer collects the join's emissions while a related
  // (not base) row is edited — proving the join re-hydrates incrementally and
  // the base issue row is reused (same reference), never re-resolved.
  it("re-hydrates on a related-row write without re-resolving the base", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* makeServer;
          const { engine } = yield* makeClient(handler, "a");
          yield* seed(engine);
          yield* syncAll(engine);

          const seen = yield* SubscriptionRef.make<
            ReadonlyArray<ReadonlyArray<Related.RelatedRow>>
          >([]);
          const i1Bodies = (rows: ReadonlyArray<Related.RelatedRow>) =>
            commentBodies(rows.find((r) => r.id === "i1")!).toSorted();
          const emitted = (
            until: (emissions: ReadonlyArray<ReadonlyArray<Related.RelatedRow>>) => boolean,
            failure: string
          ) => waitForEmissions(seen, until, failure, (emissions) => emissions.map(i1Bodies));
          yield* Effect.forkScoped(
            Stream.runForEach(
              Related.observe(engine, registry, "issues", issues, ["author", "comments"]),
              (rows) => SubscriptionRef.update(seen, (acc) => [...acc, rows])
            )
          );
          // The first emission is recorded before the write, so it holds the
          // pre-write rows.
          yield* emitted((emissions) => emissions.length > 0, "the join never emitted");

          yield* engine.mutate("comment/set", { id: "c1", issueId: "i1", body: "edited" });
          yield* engine.push;
          yield* engine.pull;

          // The pulled (authoritative) join carries the edit...
          const settled = i1Bodies(
            yield* Related.query(engine, registry, "issues", issues, ["author", "comments"])
          );
          expect(settled).toEqual(["edited", "second"]);
          // ...and the observer re-emits it. Its emissions can lag the pull
          // (and a push ack briefly re-emits the pre-edit join, #286), so wait
          // for the latest one to match rather than reading a snapshot.
          const emissions = yield* emitted(
            (acc) =>
              acc.length >= 2 &&
              JSON.stringify(i1Bodies(acc[acc.length - 1]!)) === JSON.stringify(settled),
            "the join never re-emitted the pulled edit"
          );
          const firstI1 = emissions[0]!.find((r) => r.id === "i1")!;
          const lastI1 = emissions[emissions.length - 1]!.find((r) => r.id === "i1")!;
          // `many` order follows the foreign collection's row order (a write can
          // reorder it), so compare as sets.
          expect(commentBodies(firstI1).toSorted()).toEqual(["first", "second"]);
          expect(commentBodies(lastI1).toSorted()).toEqual(["edited", "second"]);
          expect(emissions.length).toBeGreaterThanOrEqual(2);
          // The base issue row object was reused across the re-hydration.
          expect(lastI1.value).toBe(firstI1.value);
        })
      )
    );
  }, 10000);

  // Regression: a foreign-row write landing
  // between the join's index priming and its foreign observers subscribing
  // must not be lost. The write happens inside the consumer of the FIRST
  // emission — strictly before the concat proceeds to the merged foreign
  // observers — which an initial-emission drop would swallow, leaving the
  // join stale until the next foreign write.
  it("does not lose a foreign write racing the observer subscription", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* makeServer;
          const { engine } = yield* makeClient(handler, "race");
          yield* seed(engine);
          yield* syncAll(engine);

          const seen = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(
              Related.observe(engine, registry, "issues", issues, ["author"]),
              (rows) =>
                Effect.gen(function* () {
                  const names = rows
                    .map((row) => (row.related.author as Person | null)?.name ?? "nobody")
                    .join(",");
                  const priors = yield* SubscriptionRef.getAndUpdate(seen, (acc) => [
                    ...acc,
                    names,
                  ]);
                  if (priors.length === 0) {
                    yield* engine.mutate("person/set", { id: "p1", name: "Grace" });
                  }
                })
            )
          );
          // Wait for the join to show the racing write; a lost write never
          // arrives, so the bounded wait fails with what the join emitted.
          const emissions = yield* waitForEmissions(
            seen,
            (acc) => acc[acc.length - 1] === "Grace,Grace",
            "the racing write never reached the join"
          );
          expect(emissions[0]).toBe("Ada,Ada");
          expect(emissions[emissions.length - 1]).toBe("Grace,Grace");
        })
      )
    );
  }, 10000);
});

describe("Related.related", () => {
  it.effect("auto-subscribes narrowed foreign subsets and tears them down with the scope", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine); // rows exist server-side; related does its own subscribe+pull

      const subscribed: Array<Subset.Subset> = [];
      const unsubscribed: Array<Subset.Subset> = [];
      const spy: ClientEngineModule.ClientEngine = {
        ...engine,
        subscribe: (s) =>
          Effect.sync(() => void subscribed.push(s)).pipe(Effect.andThen(engine.subscribe(s))),
        unsubscribe: (s) =>
          Effect.sync(() => void unsubscribed.push(s)).pipe(Effect.andThen(engine.unsubscribe(s))),
      };

      const scope = yield* Scope.make();
      const stream = yield* Related.related(spy, registry, "issues", issues, [
        "author",
        "comments",
      ]).pipe(Effect.provideService(Scope.Scope, scope));
      const head = yield* Stream.runHead(stream);
      const i1 = (head._tag === "Some" ? head.value : []).find((r) => r.id === "i1")!;
      expect((i1.related.author as Person).name).toBe("Ada");
      expect(commentBodies(i1)).toEqual(["first", "second"]);

      // A narrowed `issueId IN (...)` subset of comments and an `id IN (...)`
      // subset of people were subscribed, alongside the base issues subset.
      const narrowed = (collection: string, field: string) =>
        subscribed.some(
          (s) => s.collection === collection && s.where._tag === "In" && s.where.field === field
        );
      expect(narrowed("comments", "issueId")).toBe(true);
      expect(narrowed("people", "id")).toBe(true);

      // Closing the scope unsubscribes everything the read had subscribed.
      yield* Scope.close(scope, Exit.void);
      const unsubCollections = new Set(unsubscribed.map((s) => s.collection));
      expect(unsubCollections.has("issues")).toBe(true);
      expect(unsubCollections.has("comments")).toBe(true);
      expect(unsubCollections.has("people")).toBe(true);
    })
  );
});

describe("Related.resolveExistsLocally", () => {
  it.effect("renders a client-side `Predicate.exists` over a synced foreign collection", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine);
      yield* syncAll(engine);

      // Issues that have at least one comment: i1 (c1, c2) yes, i2 no.
      const predicate = Predicate.exists({
        collection: "comments",
        localField: "id",
        foreignField: "issueId",
      });
      const resolved = yield* Related.resolveExistsLocally(engine, predicate);
      const rows = yield* engine.query(Subset.make({ collection: "issues", where: resolved }));
      expect(rows.map((r) => r.id)).toEqual(["i1"]);
    })
  );
});

// ─── Delta-maintenance property test (issue #111) ────────────────────────────
//
// `Related.makeJoinEngine` maintains the join incrementally from base/foreign
// row snapshots (put/delete-shaped deltas, including fk changes that move a
// row between buckets) instead of re-grouping and re-hydrating from scratch.
// This drives it directly (no ClientEngine/Effect involved — the engine is
// pure) with a long randomized sequence of deltas over base rows, foreign
// rows (including a windowed/paginated target, ADR-0024), and fk reassignment,
// and after every prefix compares its result against `Related.hydrateFromScratch`
// computed fresh from the same ground truth. Deterministic (seeded PRNG) so a
// failure is reproducible from the printed seed.

type LocalRow = ClientEngineModule.LocalRow;

// mulberry32: small, fast, seedable — good enough for a reproducible fuzz run.
const mulberry32 = (rngSeed: number) => {
  let state = rngSeed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const propertyRelationships: ReadonlyArray<Collection.Relationship & { readonly first?: number }> =
  [
    {
      name: "author",
      kind: "one",
      collection: "people",
      localField: "authorId",
      foreignField: "id",
    },
    {
      name: "comments",
      kind: "many",
      collection: "comments",
      localField: "id",
      foreignField: "issueId",
    },
    {
      name: "tags",
      kind: "paginated",
      collection: "tags",
      localField: "id",
      foreignField: "issueId",
      order: [{ field: "rank", direction: "asc" }],
      first: 2,
    },
  ];

const ISSUE_IDS = ["i0", "i1", "i2", "i3", "i4"];
const PERSON_IDS = ["p0", "p1", "p2"];
// Occasionally points a comment/tag at an issue id no base row currently
// holds — a dangling fk, which must resolve like any other non-match.
const FK_TARGETS = [...ISSUE_IDS, "i-missing"];

/** Ground truth: one `Map<id, LocalRow>` per collection, mutated by each op. */
interface GroundTruth {
  readonly issues: Map<string, LocalRow>;
  readonly people: Map<string, LocalRow>;
  readonly comments: Map<string, LocalRow>;
  readonly tags: Map<string, LocalRow>;
}

const emptyGroundTruth = (): GroundTruth => ({
  issues: new Map(),
  people: new Map(),
  comments: new Map(),
  tags: new Map(),
});

const foreignRowsOf = (truth: GroundTruth): ReadonlyMap<string, ReadonlyArray<LocalRow>> =>
  new Map([
    ["people", [...truth.people.values()]],
    ["comments", [...truth.comments.values()]],
    ["tags", [...truth.tags.values()]],
  ]);

type ForeignCollection = "people" | "comments" | "tags";

type Op =
  | { readonly _tag: "putIssue"; readonly id: string; readonly authorId: string | null }
  | { readonly _tag: "deleteIssue"; readonly id: string }
  | {
      readonly _tag: "putForeign";
      readonly collection: ForeignCollection;
      readonly id: string;
      readonly fk: string;
      readonly rank: number;
    }
  | { readonly _tag: "deleteForeign"; readonly collection: ForeignCollection; readonly id: string };

const pick = <A>(rng: () => number, values: ReadonlyArray<A>): A =>
  values[Math.floor(rng() * values.length)]!;

const FOREIGN_COLLECTIONS: ReadonlyArray<ForeignCollection> = ["people", "comments", "tags"];
const FOREIGN_ID_PREFIX: Record<ForeignCollection, string> = {
  people: "fp",
  comments: "fc",
  tags: "ft",
};

const poolOf = (truth: GroundTruth, collection: ForeignCollection) => truth[collection];

const randomPutIssue = (rng: () => number): Op => ({
  _tag: "putIssue",
  id: pick(rng, ISSUE_IDS),
  authorId: rng() < 0.15 ? null : pick(rng, PERSON_IDS),
});

const randomPutForeign = (rng: () => number, collection: ForeignCollection): Op => ({
  _tag: "putForeign",
  collection,
  id: `${FOREIGN_ID_PREFIX[collection]}${Math.floor(rng() * 6)}`,
  fk: collection === "people" ? pick(rng, PERSON_IDS) : pick(rng, FK_TARGETS),
  rank: Math.floor(rng() * 10),
});

/** Weighted: 30% put issue, 10% delete issue, 35% put foreign, 25% delete foreign. */
const randomOp = (rng: () => number, truth: GroundTruth): Op => {
  const choice = rng();
  if (choice < 0.3) return randomPutIssue(rng);
  if (choice < 0.4) return { _tag: "deleteIssue", id: pick(rng, ISSUE_IDS) };

  const collection = pick(rng, FOREIGN_COLLECTIONS);
  const pool = poolOf(truth, collection);
  return choice < 0.75 || pool.size === 0
    ? randomPutForeign(rng, collection)
    : { _tag: "deleteForeign", collection, id: pick(rng, [...pool.keys()]) };
};

const applyOp = (truth: GroundTruth, op: Op): void => {
  switch (op._tag) {
    case "putIssue":
      truth.issues.set(op.id, { id: op.id, value: { id: op.id, authorId: op.authorId } });
      return;
    case "deleteIssue":
      truth.issues.delete(op.id);
      return;
    case "putForeign": {
      const map = truth[op.collection];
      const value =
        op.collection === "people"
          ? { id: op.id }
          : op.collection === "comments"
            ? { id: op.id, issueId: op.fk }
            : { id: op.id, issueId: op.fk, rank: op.rank };
      map.set(op.id, { id: op.id, value });
      return;
    }
    case "deleteForeign":
      truth[op.collection].delete(op.id);
      return;
  }
};

const idsOf = (values: ReadonlyArray<unknown>) =>
  values.map((v) => (v as { id: string }).id).sort();

/** `many`/`paginated` order isn't a contract (a write can reorder a bucket —
 * see the `re-hydrates on a related-row write` test above), so compare those
 * as sets; `one` and the base row compare directly. */
const relatedValuesEqual = (a: Related.RelatedValue, b: Related.RelatedValue): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(idsOf(a)) === JSON.stringify(idsOf(b));
  }
  return a === b;
};

const sameJoinUnordered = (
  actual: ReadonlyArray<Related.RelatedRow>,
  expected: ReadonlyArray<Related.RelatedRow>
): boolean =>
  actual.length === expected.length &&
  actual.every((row, i) => {
    const other = expected[i]!;
    if (row.id !== other.id || row.value !== other.value) return false;
    const names = Object.keys(row.related);
    return (
      names.length === Object.keys(other.related).length &&
      names.every((name) => relatedValuesEqual(row.related[name], other.related[name]))
    );
  });

describe("Related delta-maintenance (issue #111)", () => {
  it("makeJoinEngine matches hydrateFromScratch after every prefix of randomized deltas", () => {
    const rngSeed = 0xc0ffee; // fixed: a failure is reproducible from this constant
    const rng = mulberry32(rngSeed);
    const strategy = Related.fieldMappingStrategy(propertyRelationships);
    const engine = Related.makeJoinEngine(strategy);
    const truth = emptyGroundTruth();
    let lastResult: ReadonlyArray<Related.RelatedRow> = [];

    const primeAdded = (collections: ReadonlyArray<string>) => {
      for (const collection of collections) {
        const rows = [...truth[collection as ForeignCollection].values()];
        const { result } = engine.applyForeign(collection, rows);
        if (result !== undefined) lastResult = result;
      }
    };

    for (let step = 0; step < 400; step++) {
      const op = randomOp(rng, truth);
      applyOp(truth, op);

      if (op._tag === "putIssue" || op._tag === "deleteIssue") {
        const { added, removed, result } = engine.applyBase([...truth.issues.values()]);
        expect(removed).toEqual([]); // this strategy's target set is static
        if (result !== undefined) lastResult = result;
        primeAdded(added);
      } else {
        const { result } = engine.applyForeign(op.collection, [...truth[op.collection].values()]);
        if (result !== undefined) lastResult = result;
      }

      const expected = Related.hydrateFromScratch(
        strategy,
        [...truth.issues.values()],
        foreignRowsOf(truth)
      );
      expect(
        sameJoinUnordered(lastResult, expected),
        `step ${step} (seed ${rngSeed}) diverged from from-scratch hydrate:\n` +
          `op: ${JSON.stringify(op)}\n` +
          `actual:   ${JSON.stringify(lastResult)}\n` +
          `expected: ${JSON.stringify(expected)}`
      ).toBe(true);
    }
  });
});
