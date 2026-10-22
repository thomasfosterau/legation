/**
 * ClientEngine.observeWindow / Subscriptions.acquireWindow (#133 item 3):
 * reactive window retargeting. `retarget` widens/advances an open
 * observation's `limit`/`cursor` by reusing `LiveView`'s maintained order
 * (`LiveView.retarget`) instead of the caller re-subscribing with a wider
 * subset (which would tear the observation down and rebuild the maintained
 * order from scratch). These tests assert the *observable* consequence of
 * "reuses the maintained tree": retargeting over rows already locally synced
 * resolves the wider page with no additional `ViewRebuilt` engine event —
 * were it re-subscribing/rebuilding, a `Rebuild` (and its `ViewRebuilt`)
 * would fire.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subscriptions from "../Subscriptions.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Item {
  readonly id: string;
  readonly rank: number;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("item/set", Schema.Unknown),
    local: (args, writer) => writer.put("items", (args as Item).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "item/set": (args, writer) => Effect.asVoid(writer.put("items", (args as Item).id, args)),
};

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ items: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

const makeClient = (handler: ServerHandler, group: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, group);
    return yield* ClientEngineModule.make({
      clientId: group,
      clientGroupId: group,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const ranked = Subset.make({
  collection: "items",
  orderBy: [{ field: "rank", direction: "asc" }],
  limit: 3,
});

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));
const settle = sleepReal(200);

const eventually = <A, E>(read: Effect.Effect<A, E>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = yield* read.pipe(Effect.orDie);
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id);

describe("ClientEngine.observeWindow", () => {
  it("retarget widens the page without an extra rebuild, over rows already synced", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer-window");
        const reader = yield* makeClient(handler, "reader-window");
        yield* reader.subscribe(Subset.make({ collection: "items" }));

        // Seed 6 rows on the server, then pull them all locally before ever
        // observing — retargeting from here on is a pure local reslice.
        for (let i = 0; i < 6; i++) {
          yield* writer.mutate("item/set", { id: `i${i}`, rank: i });
        }
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(
          reader.query(Subset.make({ collection: "items" })),
          (rows) => rows.length === 6
        );

        const rebuilds = yield* Ref.make(0);
        yield* Effect.forkScoped(
          Stream.runForEach(reader.engineEvents, (event) =>
            event._tag === "ViewRebuilt" ? Ref.update(rebuilds, (n) => n + 1) : Effect.void
          ).pipe(Effect.ignore)
        );
        yield* settle;
        const rebuildsBefore = yield* Ref.get(rebuilds);

        const observation = yield* reader.observeWindow(ranked);
        const pages = yield* Ref.make<Array<ReadonlyArray<{ readonly id: string }>>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(observation.rows, (page) =>
            Ref.update(pages, (a) => [...a, page])
          ).pipe(Effect.ignore)
        );
        yield* settle;

        const initial = yield* Ref.get(pages);
        expect(ids(initial[initial.length - 1]!)).toEqual(["i0", "i1", "i2"]);

        yield* observation.retarget({ limit: 6 });
        yield* eventually(Ref.get(pages), (seen) => ids(seen[seen.length - 1]!).length === 6);

        const widened = yield* Ref.get(pages);
        expect(ids(widened[widened.length - 1]!)).toEqual(["i0", "i1", "i2", "i3", "i4", "i5"]);

        // The whole point: reslicing the maintained order, not a re-subscribe
        // + rebuild — no extra `ViewRebuilt` fired for the retarget itself.
        const rebuildsAfter = yield* Ref.get(rebuilds);
        expect(rebuildsAfter).toBe(rebuildsBefore);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("advancing the cursor slides the window forward, reusing the maintained order", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer-cursor");
        const reader = yield* makeClient(handler, "reader-cursor");
        yield* reader.subscribe(Subset.make({ collection: "items" }));

        for (let i = 0; i < 6; i++) {
          yield* writer.mutate("item/set", { id: `i${i}`, rank: i });
        }
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(
          reader.query(Subset.make({ collection: "items" })),
          (rows) => rows.length === 6
        );

        const observation = yield* reader.observeWindow(ranked);
        const pages = yield* Ref.make<Array<ReadonlyArray<{ readonly id: string }>>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(observation.rows, (page) =>
            Ref.update(pages, (a) => [...a, page])
          ).pipe(Effect.ignore)
        );
        yield* settle;
        const initial = yield* Ref.get(pages);
        expect(ids(initial[initial.length - 1]!)).toEqual(["i0", "i1", "i2"]);

        // Advance the cursor past "i2" — the window slides to the next 3.
        yield* observation.retarget({ cursor: "i2" });
        yield* eventually(Ref.get(pages), (seen) => ids(seen[seen.length - 1]!)[0] === "i3");
        const advanced = yield* Ref.get(pages);
        expect(ids(advanced[advanced.length - 1]!)).toEqual(["i3", "i4", "i5"]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("a genuine engine change after a retarget is folded over the retargeted window", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer-mixed");
        const reader = yield* makeClient(handler, "reader-mixed");
        yield* reader.subscribe(Subset.make({ collection: "items" }));

        for (let i = 0; i < 4; i++) {
          yield* writer.mutate("item/set", { id: `i${i}`, rank: i });
        }
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(
          reader.query(Subset.make({ collection: "items" })),
          (rows) => rows.length === 4
        );

        const observation = yield* reader.observeWindow(ranked); // limit 3
        const pages = yield* Ref.make<Array<ReadonlyArray<{ readonly id: string }>>>([]);
        yield* Effect.forkScoped(
          Stream.runForEach(observation.rows, (page) =>
            Ref.update(pages, (a) => [...a, page])
          ).pipe(Effect.ignore)
        );
        yield* settle;

        yield* observation.retarget({ limit: 10 }); // widen past the current 4 rows
        yield* eventually(Ref.get(pages), (seen) => ids(seen[seen.length - 1]!).length === 4);

        // A row inserted after the retarget must show up in the *widened*
        // window — proving the retargeted subset (not the original limit 3)
        // drives subsequent Rebuild/Patch handling.
        yield* writer.mutate("item/set", { id: "i4", rank: 4 });
        yield* writer.push;
        yield* reader.pull;
        yield* eventually(Ref.get(pages), (seen) => ids(seen[seen.length - 1]!).length === 5);
        const final = yield* Ref.get(pages);
        expect(ids(final[final.length - 1]!)).toEqual(["i0", "i1", "i2", "i3", "i4"]);
      }).pipe(Effect.scoped)
    );
  }, 10000);
});

describe("Subscriptions.acquireWindow", () => {
  it("retarget keeps the engine's tracked subscription in step, and release drops the current one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "subs-window");
        const subs = yield* Subscriptions.make(engine, { ttl: Duration.minutes(5) });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* subs.acquireWindow(ranked);
            const activeAfterAcquire = yield* engine.activeSubscriptions;
            expect(activeAfterAcquire.some((s) => Subset.hash(s) === Subset.hash(ranked))).toBe(
              true
            );

            yield* handle.retarget({ limit: 9 });
            const widened = Subset.make({
              collection: ranked.collection,
              orderBy: ranked.orderBy,
              limit: 9,
            });
            const activeAfterRetarget = yield* engine.activeSubscriptions;
            expect(activeAfterRetarget.some((s) => Subset.hash(s) === Subset.hash(widened))).toBe(
              true
            );
            expect(activeAfterRetarget.some((s) => Subset.hash(s) === Subset.hash(ranked))).toBe(
              false
            );

            yield* handle.release;
            const activeAfterRelease = yield* engine.activeSubscriptions;
            expect(activeAfterRelease.some((s) => Subset.hash(s) === Subset.hash(widened))).toBe(
              false
            );
          })
        );
      }).pipe(Effect.scoped)
    );
  }, 10000);
});
