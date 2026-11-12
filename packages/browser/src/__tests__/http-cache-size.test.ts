/**
 * The Cache API HTTP cache's bundle-size budget (#678): a service worker that
 * imports `CacheApiHttpCache` alone ships the cache, Effect and the error
 * classes' schemas, and nothing of the engine.
 *
 * Every size is relative to a floor measured in the same run, with the same
 * bundler and the same `effect`, so the budget holds at any `effect` version
 * the suite runs at:
 *
 * - bare Effect (`Effect.runPromise`);
 * - the error floor: bare Effect plus two `Schema.TaggedError` classes shaped
 *   like core's `StoreError` / `TransportError`, which every
 *   tagged-error-carrying module pays for: an error class is a
 *   `Schema.TaggedError`, and `effect/Schema` is ~15-18 KB gzip on its own.
 *
 * The budget is on the cache's own weight over the error floor; the module
 * list guards what the cache path must never reach.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import effectManifest from "../../../effect/package.json" with { type: "json" };
import browserManifest from "../../package.json" with { type: "json" };
import { measurer } from "./bundle-size.js";

const KB = 1024;

/** The cache's own minified, gzipped weight over the error floor. */
const budgetOverErrorFloor = 6 * KB;

const runtime = `import * as Effect from "effect/Effect";
export const run = (n) => Effect.runPromise(Effect.succeed(n));`;

const bareEffect = runtime;

/** Two tagged errors shaped like core's, defined here so the floor owes nothing to the packing. */
const errorFloor = `${runtime}
import * as Schema from "effect/Schema";
const fields = { message: Schema.String, cause: Schema.optional(Schema.Defect()) };
export class StoreError extends Schema.TaggedError()("StoreError", fields) {}
export class TransportError extends Schema.TaggedError()("TransportError", fields) {}`;

const viaEntry = (specifier: string) => `${runtime}
export { CacheApiHttpCache } from "${specifier}";`;

/** Modules the cache path must not reach: the engine, and what only the engine needs. */
const forbidden = [
  /^@thomasfosterau\/legation\/(MemoryBackend|ClientEngine|ClientStore|SyncServer|Mirror)/,
  /^@thomasfosterau\/legation-browser\/(HttpCacheInvalidation|ServiceWorkerHost|IndexedDb)/,
  /^effect\/(PubSub|Metric|HashMap|Random|Stream|Queue|Layer)\.js$/,
];

const measure = measurer([
  { directory: new URL("../../../effect/", import.meta.url), manifest: effectManifest },
  { directory: new URL("../../", import.meta.url), manifest: browserManifest },
]);

describe("CacheApiHttpCache bundle size (#678)", () => {
  it.effect(
    "bundles within budget over the error floor, from either entry, reaching nothing of the engine",
    () =>
      Effect.gen(function* () {
        const bundle = yield* measure;
        const bare = yield* bundle(bareEffect);
        const floor = yield* bundle(errorFloor);
        yield* Effect.forEach(
          ["@thomasfosterau/legation-browser/http-cache", "@thomasfosterau/legation-browser"],
          (specifier) =>
            Effect.map(bundle(viaEntry(specifier)), (cache) => {
              const over = cache.gzip - floor.gzip;
              expect(
                over,
                `${specifier}: ${cache.gzip} B gzip, ${over} B over the error floor ` +
                  `(${floor.gzip} B), ${cache.gzip - bare.gzip} B over bare Effect (${bare.gzip} B)`
              ).toBeLessThanOrEqual(budgetOverErrorFloor);
              expect(
                Arr.filter(cache.modules, (id) =>
                  Arr.some(forbidden, (pattern) => pattern.test(id))
                )
              ).toEqual([]);
              expect(cache.modules).toContain(
                "@thomasfosterau/legation-browser/CacheApiHttpCache.js"
              );
            }),
          { concurrency: 1, discard: true }
        );
      }),
    60_000
  );
});
