/**
 * Related tests: declared field-mapping relationships resolved over the local
 * mirror. Registry validation (duplicate + unknown foreign collection), `one`
 * and `many` resolution with incremental re-hydration that leaves the base
 * untouched, `related`'s auto-subscription + scope teardown, and client-side
 * `Predicate.exists` rendering.
 */
import * as P from "effect/Predicate";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Collection from "../Collection.js";
import * as Cvr from "../Cvr.js";
import type * as ClientView from "../ClientView.js";
import { DuplicateNameError, StoreError, UnknownCollectionError } from "../Errors.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Related from "../Related.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";
import { defined } from "./defined.js";
import { TestFailure } from "./test-failure.js";
import * as Json from "../internal/Json.js";
import { idOf } from "./shapes.js";
import { ClientGroupId, RowId } from "../Protocol.js";

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

const Issue: Schema.Codec<Issue> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
});
const Comment: Schema.Codec<CommentRow> = Schema.Struct({
  id: Schema.String,
  issueId: Schema.String,
  body: Schema.String,
});
const Person: Schema.Codec<Person> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const issuesCollection = Collection.make({
  name: "issues",
  schema: Issue,
  id: (row) => RowId.make(row.id),
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
  schema: Comment,
  id: (row) => RowId.make(row.id),
});
const peopleCollection = Collection.make({
  name: "people",
  schema: Person,
  id: (row) => RowId.make(row.id),
});

const registry = Collection.registry([issuesCollection, commentsCollection, peopleCollection]);

// A generic "set" mutator per collection: put the row value at its id.
const setRow =
  (collection: string) =>
  (args: unknown, writer: { put: (c: string, id: RowId, v: unknown) => any }) =>
    writer.put(collection, RowId.make(idOf(args)), args);

const mutators = Mutator.registry([
  { mutator: Mutator.make("issue/set", Schema.Unknown), local: setRow("issues") },
  { mutator: Mutator.make("comment/set", Schema.Unknown), local: setRow("comments") },
  { mutator: Mutator.make("person/set", Schema.Unknown), local: setRow("people") },
]);

const backendHandlers = {
  "issue/set": (args, writer) => Effect.asVoid(writer.put("issues", RowId.make(idOf(args)), args)),
  "comment/set": (args, writer) =>
    Effect.asVoid(writer.put("comments", RowId.make(idOf(args)), args)),
  "person/set": (args, writer) => Effect.asVoid(writer.put("people", RowId.make(idOf(args)), args)),
} satisfies Record<string, MemoryBackend.BackendHandler>;

const authPolicy = Authorization.policy({
  issues: Authorization.allowAll,
  comments: Authorization.allowAll,
  people: Authorization.allowAll,
});

const makeServer = Effect.fn("makeServer")(function* (): Effect.fn.Return<
  ServerHandler,
  never,
  Scope.Scope
> {
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
    const transport = yield* makeInMemory(handler, ClientGroupId.make(`group-${name}`));
    const engine = yield* ClientEngineModule.make({
      clientId: `client-${name}`,
      clientGroupId: ClientGroupId.make(`group-${name}`),
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

const decodeComments = Schema.decodeUnknownSync(Schema.Array(Comment));
const decodeAuthor = Schema.decodeUnknownSync(Person);
const decodeOptionalAuthor = Schema.decodeUnknownSync(Schema.NullOr(Person));

const commentBodies = (row: Related.RelatedRow): ReadonlyArray<string> =>
  decodeComments(row.related.comments).map((c) => c.body);

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
  show: (emissions: A) => string = (emissions) => Json.show(emissions)
): Effect.Effect<A> =>
  SubscriptionRef.changes(seen).pipe(
    Stream.filter(until),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new TestFailure({ message: `${failure}; the changes stream ended` })),
        onSome: Effect.succeed,
      })
    ),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.flatMap(SubscriptionRef.get(seen), (emissions) =>
          Effect.die(new TestFailure({ message: `${failure}; saw ${show(emissions)}` }))
        ),
    })
  );

describe("Collection.registry relationship validation", () => {
  it("throws on a duplicate relationship name within a collection", () => {
    const bad = Collection.make({
      name: "a",
      schema: Person,
      id: (r) => RowId.make(r.id),
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
      schema: Person,
      id: (r) => RowId.make(r.id),
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
      const handler = yield* makeServer();
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine);
      yield* syncAll(engine);

      const rows = yield* Related.query(engine, registry, "issues", issues, ["author", "comments"]);
      const i1 = defined(rows.find((r) => r.id === "i1"));
      expect(decodeAuthor(i1.related.author).name).toBe("Ada");
      expect(commentBodies(i1)).toEqual(["first", "second"]);
      // The comment-less issue resolves to an empty list, not undefined.
      expect(commentBodies(defined(rows.find((r) => r.id === "i2")))).toEqual([]);
    })
  );

  // Real-clock: a forked observer collects the join's emissions while a related
  // (not base) row is edited — proving the join re-hydrates incrementally and
  // the base issue row is reused (same reference), never re-resolved.
  it.effect(
    "re-hydrates on a related-row write without re-resolving the base",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* makeServer();
          const { engine } = yield* makeClient(handler, "a");
          yield* seed(engine);
          yield* syncAll(engine);

          const seen = yield* SubscriptionRef.make<
            ReadonlyArray<ReadonlyArray<Related.RelatedRow>>
          >([]);
          const i1Bodies = (rows: ReadonlyArray<Related.RelatedRow>) =>
            commentBodies(defined(rows.find((r) => r.id === "i1"))).toSorted();
          const emitted = (
            until: (emissions: ReadonlyArray<ReadonlyArray<Related.RelatedRow>>) => boolean,
            failure: string
          ) =>
            waitForEmissions(seen, until, failure, (emissions) =>
              Json.stringify(emissions.map(i1Bodies))
            );
          yield* Effect.forkScoped(
            Stream.runForEach(
              Related.observe(engine, registry, "issues", issues, ["author", "comments"]),
              (rows) => SubscriptionRef.update(seen, (acc) => [...acc, rows])
            )
          );
          // The first emission is recorded before the write, so it holds the
          // pre-write rows.
          yield* emitted(
            (emissions) => Arr.isReadonlyArrayNonEmpty(emissions),
            "the join never emitted"
          );

          yield* engine.mutate("comment/set", { id: "c1", issueId: "i1", body: "edited" });
          yield* engine.push;
          yield* engine.pull;

          // The pulled (authoritative) join carries the edit...
          const settled = i1Bodies(
            yield* Related.query(engine, registry, "issues", issues, ["author", "comments"])
          );
          expect(settled).toEqual(["edited", "second"]);
          // ...and the observer re-emits it. Its emissions can lag the pull
          // (and a push ack briefly re-emits the pre-edit join), so wait
          // for the latest one to match rather than reading a snapshot.
          const emissions = yield* emitted(
            (acc) =>
              acc.length >= 2 &&
              Json.show(i1Bodies(defined(acc[acc.length - 1]))) === Json.show(settled),
            "the join never re-emitted the pulled edit"
          );
          const firstI1 = defined(defined(emissions[0]).find((r) => r.id === "i1"));
          const lastI1 = defined(
            defined(emissions[emissions.length - 1]).find((r) => r.id === "i1")
          );
          // `many` order follows the foreign collection's row order (a write can
          // reorder it), so compare as sets.
          expect(commentBodies(firstI1).toSorted()).toEqual(["first", "second"]);
          expect(commentBodies(lastI1).toSorted()).toEqual(["edited", "second"]);
          expect(emissions.length).toBeGreaterThanOrEqual(2);
          // The base issue row object was reused across the re-hydration.
          expect(lastI1.value).toBe(firstI1.value);
        })
      ),
    10000
  );

  // Regression: a foreign-row write landing
  // between the join's index priming and its foreign observers subscribing
  // must not be lost. The write happens inside the consumer of the FIRST
  // emission — strictly before the concat proceeds to the merged foreign
  // observers — which an initial-emission drop would swallow, leaving the
  // join stale until the next foreign write.
  it.effect(
    "does not lose a foreign write racing the observer subscription",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* makeServer();
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
                    .map((row) => decodeOptionalAuthor(row.related.author)?.name ?? "nobody")
                    .join(",");
                  const priors = yield* SubscriptionRef.getAndUpdate(seen, (acc) => [
                    ...acc,
                    names,
                  ]);
                  if (Arr.isReadonlyArrayEmpty(priors)) {
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
      ),
    10000
  );
});

// A view over the engine whose reads of `people` fail as a replica read can.
const failingPeople = (
  engine: ClientEngineModule.ClientEngine,
  fail: { readonly query?: boolean; readonly observe?: boolean }
): ClientView.Reader => ({
  query: (subset) =>
    fail.query === true && subset.collection === "people"
      ? Effect.fail(new StoreError({ message: "the people store is unreadable" }))
      : engine.query(subset),
  observe: (subset) =>
    fail.observe === true && subset.collection === "people"
      ? Stream.die(new TestFailure({ message: "the people observer died" }))
      : engine.observe(subset),
});

describe("Related reads over a failing view", () => {
  it.effect("a one-shot join fails with the view's error", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine);
      yield* syncAll(engine);
      const view = failingPeople(engine, { query: true });
      const error = yield* Effect.flip(
        Related.query(view, registry, "issues", issues, ["author", "comments"])
      );
      expect(error._tag).toBe("StoreError");
      expect(error.message).toBe("the people store is unreadable");
    })
  );

  // Real clock: before the join forwarded its observers' defects, this stream
  // never ended, so the test would time out rather than fail.
  it.live("a live join ends with the defect of an observer that dies", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
      const { engine } = yield* makeClient(handler, "a");
      yield* seed(engine);
      yield* syncAll(engine);
      const view = failingPeople(engine, { observe: true });
      const exit = yield* Related.observe(view, registry, "issues", issues, ["author"]).pipe(
        Stream.runDrain,
        Effect.timeout("5 seconds"),
        Effect.exit
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
        "the people observer died"
      );
    }).pipe(Effect.scoped)
  );
});

describe("Related.related", () => {
  it.effect("auto-subscribes narrowed foreign subsets and tears them down with the scope", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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
      const i1 = defined((Option.isSome(head) ? head.value : []).find((r) => r.id === "i1"));
      expect(decodeAuthor(i1.related.author).name).toBe("Ada");
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
      const unsubCollections = HashSet.fromIterable(unsubscribed.map((s) => s.collection));
      expect(HashSet.has(unsubCollections, "issues")).toBe(true);
      expect(HashSet.has(unsubCollections, "comments")).toBe(true);
      expect(HashSet.has(unsubCollections, "people")).toBe(true);
    })
  );
});

describe("Related.resolveExistsLocally", () => {
  it.effect("renders a client-side `Predicate.exists` over a synced foreign collection", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer();
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

// ─── Delta-maintenance property test ────────────────────────────
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

/** Ground truth: one `MutableHashMap<id, LocalRow>` per collection, mutated by each op. */
interface GroundTruth {
  readonly issues: MutableHashMap.MutableHashMap<string, LocalRow>;
  readonly people: MutableHashMap.MutableHashMap<string, LocalRow>;
  readonly comments: MutableHashMap.MutableHashMap<string, LocalRow>;
  readonly tags: MutableHashMap.MutableHashMap<string, LocalRow>;
}

const emptyGroundTruth = (): GroundTruth => ({
  issues: MutableHashMap.empty(),
  people: MutableHashMap.empty(),
  comments: MutableHashMap.empty(),
  tags: MutableHashMap.empty(),
});

const foreignRowsOf = (truth: GroundTruth): ReadonlyMap<string, ReadonlyArray<LocalRow>> =>
  new Map([
    ["people", [...MutableHashMap.values(truth.people)]],
    ["comments", [...MutableHashMap.values(truth.comments)]],
    ["tags", [...MutableHashMap.values(truth.tags)]],
  ]);

const ForeignCollection = Schema.Literals(["people", "comments", "tags"]);
type ForeignCollection = typeof ForeignCollection.Type;
const decodeForeign = Schema.decodeUnknownSync(ForeignCollection);

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
  defined(values[Math.floor(rng() * values.length)]);

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
  return choice < 0.75 || MutableHashMap.size(pool) === 0
    ? randomPutForeign(rng, collection)
    : { _tag: "deleteForeign", collection, id: pick(rng, [...MutableHashMap.keys(pool)]) };
};

const applyOp = (truth: GroundTruth, op: Op): void =>
  Match.value(op).pipe(
    Match.withReturnType<void>(),
    Match.tag("putIssue", (put) => {
      MutableHashMap.set(truth.issues, put.id, {
        id: RowId.make(put.id),
        value: { id: put.id, authorId: put.authorId },
      });
    }),
    Match.tag("deleteIssue", (del) => {
      MutableHashMap.remove(truth.issues, del.id);
    }),
    Match.tag("putForeign", (put) => {
      const map = truth[put.collection];
      const value =
        put.collection === "people"
          ? { id: put.id }
          : put.collection === "comments"
            ? { id: put.id, issueId: put.fk }
            : { id: put.id, issueId: put.fk, rank: put.rank };
      MutableHashMap.set(map, put.id, { id: RowId.make(put.id), value });
    }),
    Match.tag("deleteForeign", (del) => {
      MutableHashMap.remove(truth[del.collection], del.id);
    }),
    Match.exhaustive
  );

const idsOf = (values: ReadonlyArray<unknown>) =>
  Arr.sort(
    values.map((v) => idOf(v)),
    Order.String
  );

/** `many`/`paginated` order isn't a contract (a write can reorder a bucket —
 * see the `re-hydrates on a related-row write` test above), so compare those
 * as sets; `one` and the base row compare directly. */
const relatedValuesEqual = (a: Related.RelatedValue, b: Related.RelatedValue): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return Json.show(idsOf(a)) === Json.show(idsOf(b));
  }
  return a === b;
};

const sameJoinUnordered = (
  actual: ReadonlyArray<Related.RelatedRow>,
  expected: ReadonlyArray<Related.RelatedRow>
): boolean =>
  actual.length === expected.length &&
  actual.every((row, i) => {
    const other = defined(expected[i]);
    if (row.id !== other.id || row.value !== other.value) return false;
    const names = R.keys(row.related);
    return (
      names.length === R.keys(other.related).length &&
      names.every((name) => relatedValuesEqual(row.related[name], other.related[name]))
    );
  });

describe("Related delta-maintenance", () => {
  it("makeJoinEngine matches hydrateFromScratch after every prefix of randomized deltas", () => {
    const rngSeed = 0xc0ffee; // fixed: a failure is reproducible from this constant
    const rng = mulberry32(rngSeed);
    const strategy = Related.fieldMappingStrategy(propertyRelationships);
    const engine = Related.makeJoinEngine(strategy);
    const truth = emptyGroundTruth();
    let lastResult: ReadonlyArray<Related.RelatedRow> = [];

    const primeAdded = (collections: ReadonlyArray<string>) => {
      Arr.forEach(collections, (collection) => {
        const rows = [...MutableHashMap.values(truth[decodeForeign(collection)])];
        const { result } = engine.applyForeign(collection, rows);
        if (result !== undefined) lastResult = result;
      });
    };

    Arr.forEach(Arr.range(0, 399), (step) => {
      const op = randomOp(rng, truth);
      applyOp(truth, op);

      let removedTargets: ReadonlyArray<string> = [];
      if (P.isTagged(op, "putIssue") || P.isTagged(op, "deleteIssue")) {
        const { added, removed, result } = engine.applyBase([
          ...MutableHashMap.values(truth.issues),
        ]);
        removedTargets = removed;
        if (result !== undefined) lastResult = result;
        primeAdded(added);
      } else {
        const { result } = engine.applyForeign(op.collection, [
          ...MutableHashMap.values(truth[op.collection]),
        ]);
        if (result !== undefined) lastResult = result;
      }
      expect(removedTargets).toEqual([]); // this strategy's target set is static

      const expected = Related.hydrateFromScratch(
        strategy,
        [...MutableHashMap.values(truth.issues)],
        foreignRowsOf(truth)
      );
      expect(
        sameJoinUnordered(lastResult, expected),
        `step ${step} (seed ${rngSeed}) diverged from from-scratch hydrate:\n` +
          `op: ${Json.show(op)}\n` +
          `actual:   ${Json.show(lastResult)}\n` +
          `expected: ${Json.show(expected)}`
      ).toBe(true);
    });
  });
});
