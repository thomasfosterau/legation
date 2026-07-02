/**
 * Related tests: declared field-mapping relationships resolved over the local
 * mirror. Registry validation (duplicate + unknown foreign collection), `one`
 * and `many` resolution with incremental re-hydration that leaves the base
 * untouched, `related`'s auto-subscription + scope teardown, and client-side
 * `Predicate.exists` rendering.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Ref, Schema, Scope, Stream } from "effect";
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
    const settle = Effect.sleep(Duration.millis(50));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* makeServer;
          const { engine } = yield* makeClient(handler, "a");
          yield* seed(engine);
          yield* syncAll(engine);

          const seen = yield* Ref.make<Array<ReadonlyArray<Related.RelatedRow>>>([]);
          yield* Effect.forkScoped(
            Stream.runForEach(
              Related.observe(engine, registry, "issues", issues, ["author", "comments"]),
              (rows) => Ref.update(seen, (acc) => [...acc, rows])
            )
          );
          yield* settle;

          yield* engine.mutate("comment/set", { id: "c1", issueId: "i1", body: "edited" });
          yield* engine.push;
          yield* engine.pull;
          yield* settle;

          const emissions = yield* Ref.get(seen);
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
