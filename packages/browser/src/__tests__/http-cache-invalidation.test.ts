/**
 * HTTP-cache invalidation tests (#49): a collection change drives eviction of
 * the responses tagged for that collection over the Cache API store, and
 * `collectionChanges` projects an engine's events to the touched collections.
 */
import type { ClientEngine, HttpCache } from "@legation/effect";
import { StoreError } from "@legation/effect";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
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
            changes: Stream.fromIterable<ReadonlyArray<string>>([["todos"]]),
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
            changes: Stream.fromIterable<ReadonlyArray<string>>([["todos"], ["notes"]]),
          });
          yield* Deferred.await(invalidations);
        })
      );

      // The fibre survived the first (failed) batch and evicted on the second.
      expect(calls).toBe(2);
      expect(yield* base.match(notes)).toBeUndefined();
    })
  );
});

describe("collectionChanges", () => {
  it.effect("maps PullCompleted to its collections and drops empty events", () =>
    Effect.gen(function* () {
      const events = Stream.fromIterable<ClientEngine.EngineEvent>([
        { _tag: "PullStarted" },
        { _tag: "PullCompleted", ops: 3, collections: ["todos"] },
        { _tag: "PullCompleted", ops: 0, collections: [] },
        { _tag: "ViewRebuilt", collections: ["notes"] },
        { _tag: "ViewRebuilt" },
      ]);
      const result = yield* Stream.runCollect(HttpCacheInvalidation.collectionChanges(events));
      expect(result).toEqual([["todos"], ["notes"]]);
    })
  );
});
