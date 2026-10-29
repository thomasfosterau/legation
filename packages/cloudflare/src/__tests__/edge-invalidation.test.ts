/**
 * Edge invalidation (#206): a committed write's hints become KV deletes and
 * cache tag purges, forwarded from the committing Worker to the Worker that
 * holds the cache. Eviction is fire-and-forget: a failed delete, a purge that
 * rejects or resolves `{ success: false }`, and a failed forward are logged,
 * and the write still succeeds.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { Authorization, MemoryBackend, Mutation, Server } from "@thomasfosterau/legation-effect";
import {
  HttpCache,
  InvalidationBus,
  InvalidationSink,
} from "@thomasfosterau/legation-effect/internal";
import { EdgeInvalidation } from "../index.js";

/** A binding, a KV namespace or a purge that is unreachable. */
class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
  what: Schema.String,
}) {}

/** A logger that records every warning, so a test can assert a failure was logged. */
const recordWarnings = () => {
  const lines: Array<string> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      // The first part of a log call is its message; the rest is detail.
      const [message] = Arr.ensure(options.message);
      lines.push(String(message));
    }),
  ]);
  return { lines, layer };
};

const touched: HttpCache.Touched = {
  collections: ["posts"],
  rows: [
    { collection: "posts", id: "p1" },
    { collection: "posts", id: "p2" },
  ],
};

describe("EdgeInvalidation.kv (#206)", () => {
  it.effect("deletes `{collection}:{id}` for every touched row", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = [];
      yield* EdgeInvalidation.kv({
        delete: (key) => Promise.resolve(void deleted.push(key)),
      }).invalidate(touched);
      expect(deleted.toSorted()).toEqual(["posts:p1", "posts:p2"]);
    })
  );

  it.effect("logs a failed delete and carries on with the others", () =>
    Effect.gen(function* () {
      const logs = recordWarnings();
      const deleted: Array<string> = [];
      yield* EdgeInvalidation.kv({
        delete: (key) =>
          key === "posts:p1"
            ? Promise.reject(new Unreachable({ what: "kv" }))
            : Promise.resolve(void deleted.push(key)),
      })
        .invalidate(touched)
        .pipe(Effect.provide(logs.layer));
      expect(deleted).toEqual(["posts:p2"]);
      expect(logs.lines.join("\n")).toMatch(/KV delete of "posts:p1" failed/);
    })
  );
});

describe("EdgeInvalidation.cachePurge (#206)", () => {
  it.effect("purges the coarse and fine tags, spelled as the browser's Cache API spells them", () =>
    Effect.gen(function* () {
      const purged: Array<ReadonlyArray<string>> = [];
      yield* EdgeInvalidation.cachePurge({
        purge: ({ tags }) => {
          purged.push(tags);
          return Promise.resolve({ success: true });
        },
      }).invalidate(touched);
      expect(purged).toEqual([
        [HttpCache.tagFor("posts"), "collection:posts:p1", "collection:posts:p2"],
      ]);
      expect(HttpCache.tagFor("posts")).toBe("collection:posts");
    })
  );

  it.effect("splits a large purge into calls of at most maxTagsPerPurge tags", () =>
    Effect.gen(function* () {
      const purged: Array<number> = [];
      yield* EdgeInvalidation.cachePurge(
        {
          purge: ({ tags }) => {
            purged.push(tags.length);
            return Promise.resolve({ success: true });
          },
        },
        { maxTagsPerPurge: 2 }
      ).invalidate(touched);
      expect(purged).toEqual([2, 1]);
    })
  );

  it.effect("logs a purge that resolves `{ success: false }` and one that rejects", () =>
    Effect.gen(function* () {
      const logs = recordWarnings();
      yield* EdgeInvalidation.cachePurge({
        purge: () => Promise.resolve({ success: false, errors: [{ code: 1, message: "nope" }] }),
      })
        .invalidate(touched)
        .pipe(Effect.provide(logs.layer));
      yield* EdgeInvalidation.cachePurge({
        purge: () => Promise.reject(new Unreachable({ what: "purge" })),
      })
        .invalidate(touched)
        .pipe(Effect.provide(logs.layer));
      expect(logs.lines).toEqual([
        "EdgeInvalidation: cache purge reported failure",
        "EdgeInvalidation: cache purge failed",
      ]);
    })
  );
});

describe("EdgeInvalidation.forward / receive (#206)", () => {
  it.effect("carries what a write touched to the Worker holding the cache", () =>
    Effect.gen(function* () {
      const received: Array<HttpCache.Touched> = [];
      const sink: InvalidationSink.InvalidationSink = {
        invalidate: (value) => Effect.sync(() => void received.push(value)),
      };
      // The binding carries the payload; the front door's RPC method passes it
      // to `receive`.
      const payloads: Array<string> = [];
      const target: EdgeInvalidation.InvalidationTarget = {
        invalidate: (payload) => Promise.resolve(void payloads.push(payload)),
      };
      yield* EdgeInvalidation.forward(target).invalidate(touched);
      yield* Effect.forEach(payloads, EdgeInvalidation.receive(sink), {
        concurrency: 1,
        discard: true,
      });
      expect(received).toEqual([touched]);
    })
  );

  it.effect("drops a payload that does not decode, and logs it", () =>
    Effect.gen(function* () {
      const logs = recordWarnings();
      let calls = 0;
      yield* EdgeInvalidation.receive({ invalidate: () => Effect.sync(() => void calls++) })(
        '{"collections":"posts"}'
      ).pipe(Effect.provide(logs.layer));
      expect(calls).toBe(0);
      expect(logs.lines).toEqual(["EdgeInvalidation: dropped a payload that does not decode"]);
    })
  );

  it.effect("logs a forward that fails", () =>
    Effect.gen(function* () {
      const logs = recordWarnings();
      yield* EdgeInvalidation.forward({
        invalidate: () => Promise.reject(new Unreachable({ what: "binding" })),
      })
        .invalidate(touched)
        .pipe(Effect.provide(logs.layer));
      expect(logs.lines).toEqual(["EdgeInvalidation: forwarding an invalidation failed"]);
    })
  );
});

// ─── From a committed write to the sink ──────────────────────────────────────

const Post = Schema.Struct({ id: Schema.String });
const put = Mutation.make("post/put", Post);

describe("InvalidationSink.run over a server's bus (#206)", () => {
  it.effect("a write's hint reaches the sinks, and a failing sink never fails the write", () =>
    Effect.gen(function* () {
      const bus = yield* InvalidationBus.makeInProcess;
      const backend = yield* MemoryBackend.make(
        MemoryBackend.validatedHandlers([
          MemoryBackend.handler(put, (args, writer) => writer.put("posts", args.id, args)),
        ])
      );
      const server = yield* Server.make({
        backend,
        auth: { policy: Authorization.policy({ posts: Authorization.allowAll }) },
        bus,
      });
      const deleted: Array<string> = [];
      yield* InvalidationSink.run(
        InvalidationSink.all([
          // A KV cache, and a purge whose binding is down: the KV delete still happens.
          EdgeInvalidation.kv({
            delete: (key) => Promise.resolve(void deleted.push(key)),
          }),
          EdgeInvalidation.cachePurge({
            purge: () => Promise.reject(new Unreachable({ what: "purge" })),
          }),
          { invalidate: () => Effect.die(new Unreachable({ what: "a sink with a bug" })) },
        ])
      ).pipe(Effect.provideService(InvalidationBus.InvalidationBus, bus));

      const result = yield* server.handler.handlePush({
        clientGroupId: "group-a",
        mutations: [
          {
            clientId: "client-a",
            mutationId: 1,
            mutator: put.name,
            args: { id: "p1" },
            createdAt: 0,
          },
        ],
      });
      expect(result).toBeDefined();
      // The sink runs on its own fibre, after the push has returned.
      yield* Effect.yieldNow.pipe(
        Effect.repeat({ until: () => Arr.isReadonlyArrayNonEmpty(deleted), times: 1000 })
      );
      expect(deleted).toEqual(["posts:p1"]);
    })
  );
});
