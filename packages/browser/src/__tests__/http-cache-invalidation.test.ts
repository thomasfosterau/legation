/**
 * HTTP-cache invalidation tests (#49, extended per-row by #207): a collection
 * or row change drives eviction of the responses tagged for it over the
 * Cache API store, `collectionChanges` projects an engine's events to the
 * touched collections/rows, and `tagsFor` builds a response's tags under the
 * fine-tag row budget.
 */
import type { ClientEngine, HttpCache } from "@thomasfosterau/legation-effect/internal";
import { Telemetry } from "@thomasfosterau/legation-effect/internal";
import { StoreError } from "@thomasfosterau/legation-effect";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Metric, Stream } from "effect";
import * as CacheApiHttpCache from "../CacheApiHttpCache.js";
import * as HttpCacheInvalidation from "../HttpCacheInvalidation.js";

/** Minimal in-memory Cache API fake, keyed by request URL (as in the store test). */
const makeFakeCache = (): CacheApiHttpCache.CacheLike & {
  readonly entries: Map<string, Response>;
} => {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: (request) => Promise.resolve(entries.get(request.url)?.clone()),
    put: (request, response) => {
      entries.set(request.url, response);
      return Promise.resolve();
    },
    delete: (request) => Promise.resolve(entries.delete(request.url)),
    keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
  };
};

const meta = (url: string, tags: ReadonlyArray<string>): HttpCache.CachedResponseMeta => ({
  url,
  storedAt: 0,
  staleAt: Number.MAX_SAFE_INTEGER,
  expiresAt: undefined,
  tags,
});

const noRows: HttpCacheInvalidation.Touched["rows"] = [];

describe("invalidateOnChanges", () => {
  it.effect("evicts the responses tagged for a changed collection, leaving others", () =>
    Effect.gen(function* () {
      const base = CacheApiHttpCache.make(makeFakeCache());
      // Signal once the fork has run an invalidation, so the assertion is
      // deterministic rather than timing-dependent.
      const invalidated = yield* Deferred.make<void>();
      const store: HttpCache.ResponseCacheStore = {
        ...base,
        invalidateTags: (tags) =>
          base
            .invalidateTags(tags)
            .pipe(Effect.tap(() => Deferred.succeed(invalidated, undefined))),
      };

      const todos = new Request("https://api.test/todos");
      const notes = new Request("https://api.test/notes");
      yield* store.put(todos, new Response("t"), meta(todos.url, ["collection:todos"]));
      yield* store.put(notes, new Response("n"), meta(notes.url, ["collection:notes"]));

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* HttpCacheInvalidation.invalidateOnChanges({
            store,
            changes: Stream.fromIterable<HttpCacheInvalidation.Touched>([
              { collections: ["todos"], rows: noRows },
            ]),
          });
          yield* Deferred.await(invalidated);
        })
      );

      // The todos entry (tagged collection:todos) is gone; notes is untouched.
      expect(yield* store.match(todos)).toBeUndefined();
      expect(yield* store.match(notes)).toBeDefined();
    })
  );

  it.effect("a store error is logged and does not stop later invalidations", () =>
    Effect.gen(function* () {
      const base = CacheApiHttpCache.make(makeFakeCache());
      const notes = new Request("https://api.test/notes");
      yield* base.put(notes, new Response("n"), meta(notes.url, ["collection:notes"]));

      const invalidations = yield* Deferred.make<void>();
      let calls = 0;
      const store: HttpCache.ResponseCacheStore = {
        ...base,
        invalidateTags: (tags) => {
          calls += 1;
          // Fail the first batch, succeed (and signal) on the second.
          return calls === 1
            ? Effect.fail(new StoreError({ message: "boom" }))
            : base
                .invalidateTags(tags)
                .pipe(Effect.tap(() => Deferred.succeed(invalidations, undefined)));
        },
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* HttpCacheInvalidation.invalidateOnChanges({
            store,
            changes: Stream.fromIterable<HttpCacheInvalidation.Touched>([
              { collections: ["todos"], rows: noRows },
              { collections: ["notes"], rows: noRows },
            ]),
          });
          yield* Deferred.await(invalidations);
        })
      );

      // The fibre survived the first (failed) batch and evicted on the second.
      expect(calls).toBe(2);
      expect(yield* base.match(notes)).toBeUndefined();
    })
  );

  it.effect(
    // This is the test that proves #207: a write to row A must not evict a
    // cached response that only enumerates row B, even though both rows
    // live in the same collection.
    "a write to row A does not evict a cached response containing only row B",
    () =>
      Effect.gen(function* () {
        const base = CacheApiHttpCache.make(makeFakeCache());
        const invalidated = yield* Deferred.make<void>();
        const store: HttpCache.ResponseCacheStore = {
          ...base,
          invalidateTags: (tags) =>
            base
              .invalidateTags(tags)
              .pipe(Effect.tap(() => Deferred.succeed(invalidated, undefined))),
        };

        const rowA = new Request("https://api.test/notes/a");
        const rowB = new Request("https://api.test/notes/b");
        yield* store.put(rowA, new Response("a"), meta(rowA.url, ["collection:notes:a"]));
        yield* store.put(
          rowB,
          new Response("b"),
          // rowB's cached response carries the coarse tag too (as a real
          // per-resource document under the budget would from `tagsFor`),
          // but critically NOT `collection:notes:a`.
          meta(rowB.url, ["collection:notes:b"])
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* HttpCacheInvalidation.invalidateOnChanges({
              store,
              // A write to row A only: PullCompleted reports collection
              // "notes" touched and row (notes, a) touched — never "b".
              changes: Stream.fromIterable<HttpCacheInvalidation.Touched>([
                { collections: ["notes"], rows: [{ collection: "notes", id: "a" }] },
              ]),
            });
            yield* Deferred.await(invalidated);
          })
        );

        // Row A's own entry is gone (fine tag matched).
        expect(yield* store.match(rowA)).toBeUndefined();
        // Row B's entry survives: it carries neither the fine tag for A nor
        // (in this response) the coarse tag, so the write to A cannot touch it.
        expect(yield* store.match(rowB)).toBeDefined();
      })
  );

  it.effect(
    "a row change also evicts an aggregate document tagged only with the coarse collection tag",
    () =>
      Effect.gen(function* () {
        const base = CacheApiHttpCache.make(makeFakeCache());
        const invalidated = yield* Deferred.make<void>();
        const store: HttpCache.ResponseCacheStore = {
          ...base,
          invalidateTags: (tags) =>
            base
              .invalidateTags(tags)
              .pipe(Effect.tap(() => Deferred.succeed(invalidated, undefined))),
        };

        // An aggregate document (e.g. sitemap.xml) that does not yet contain
        // the newly-written row, so it has no fine tag for it — only the
        // coarse collection tag can reach it (this is why the coarse
        // eviction in `invalidateOnChanges` is not redundant).
        const aggregate = new Request("https://api.test/notes/index");
        yield* store.put(
          aggregate,
          new Response("index"),
          meta(aggregate.url, ["collection:notes"])
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* HttpCacheInvalidation.invalidateOnChanges({
              store,
              changes: Stream.fromIterable<HttpCacheInvalidation.Touched>([
                { collections: ["notes"], rows: [{ collection: "notes", id: "new-row" }] },
              ]),
            });
            yield* Deferred.await(invalidated);
          })
        );

        expect(yield* store.match(aggregate)).toBeUndefined();
      })
  );
});

describe("collectionChanges", () => {
  it.effect("maps PullCompleted to its collections and rows, dropping empty events", () =>
    Effect.gen(function* () {
      const events = Stream.fromIterable<ClientEngine.EngineEvent>([
        { _tag: "PullStarted" },
        {
          _tag: "PullCompleted",
          ops: 1,
          collections: ["todos"],
          rows: [{ collection: "todos", id: "1" }],
        },
        { _tag: "PullCompleted", ops: 0, collections: [], rows: [] },
        { _tag: "ViewRebuilt", collections: ["notes"] },
        { _tag: "ViewRebuilt" },
      ]);
      const result = yield* Stream.runCollect(HttpCacheInvalidation.collectionChanges(events));
      expect(result).toEqual([
        { collections: ["todos"], rows: [{ collection: "todos", id: "1" }] },
        { collections: ["notes"], rows: [] },
      ]);
    })
  );
});

describe("tagsFor", () => {
  it("tags a response with the coarse tag and one fine tag per row, under budget", () => {
    const result = HttpCacheInvalidation.tagsFor("notes", ["a", "b"]);
    expect(result).toEqual({
      tags: ["collection:notes", "collection:notes:a", "collection:notes:b"],
      budgetExceeded: false,
    });
  });

  it("falls back to the coarse tag alone once the row count exceeds the budget", () => {
    const rowIds = Array.from(
      { length: HttpCacheInvalidation.FINE_TAG_ROW_BUDGET + 1 },
      (_, i) => `row-${i}`
    );
    const result = HttpCacheInvalidation.tagsFor("notes", rowIds);
    expect(result).toEqual({ tags: ["collection:notes"], budgetExceeded: true });
  });

  it("stays under budget at exactly the boundary", () => {
    const rowIds = Array.from(
      { length: HttpCacheInvalidation.FINE_TAG_ROW_BUDGET },
      (_, i) => `row-${i}`
    );
    const result = HttpCacheInvalidation.tagsFor("notes", rowIds);
    expect(result.budgetExceeded).toBe(false);
    expect(result.tags).toHaveLength(HttpCacheInvalidation.FINE_TAG_ROW_BUDGET + 1);
  });
});

describe("tagsForObserved", () => {
  it.effect(
    "records the budget-exceeded fallback on the counter, not on an under-budget call",
    () =>
      Effect.gen(function* () {
        const before = (yield* Metric.value(Telemetry.cacheTagBudgetExceededTotal)).count;

        const underBudget = yield* HttpCacheInvalidation.tagsForObserved("notes", ["a"]);
        expect(underBudget.budgetExceeded).toBe(false);
        expect((yield* Metric.value(Telemetry.cacheTagBudgetExceededTotal)).count).toBe(before);

        const overBudget = Array.from(
          { length: HttpCacheInvalidation.FINE_TAG_ROW_BUDGET + 1 },
          (_, i) => `row-${i}`
        );
        const result = yield* HttpCacheInvalidation.tagsForObserved("notes", overBudget);
        expect(result.budgetExceeded).toBe(true);
        expect((yield* Metric.value(Telemetry.cacheTagBudgetExceededTotal)).count).toBe(before + 1);
      })
  );
});
