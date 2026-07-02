/**
 * Tab-mirror tests: a real ClientEngine served by EngineHost, consumed by
 * TabMirror — over the loopback pair and over a Node BroadcastChannel.
 * Mirror updates arrive on background fibers, so assertions poll with real
 * timers (clock-independent under the test environment).
 */
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  InvalidationBus,
  MemoryBackend,
  Mutator,
  Subset,
  SyncServer,
  Transport,
} from "@legation/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import * as EngineHost from "../EngineHost.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as TabMirror from "../TabMirror.js";

const TodoArgs = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
type Todo = typeof TodoArgs.Type;

const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);

const allTodos = Subset.make({ collection: "todos" });

/** Real timers, independent of the test clock. */
const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Poll until `read` passes `until`, with a bounded number of attempts. */
const eventually = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read;
      if (until(value)) return value;
      yield* sleepReal(5);
    }
    return yield* Effect.die(new Error("eventually: condition never held"));
  });

const makeEngine = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(todoSet, (args, writer) => writer.put("todos", args.id, args)),
    ])
  );
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend.Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
  const store = yield* ClientStore.makeMemory;
  const transport = yield* Transport.makeInMemory(handler, "group-a");
  const engine = yield* ClientEngine.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
  return { engine, store };
});

describe("EngineHost ↔ TabMirror (loopback)", () => {
  it.effect("subscribe hydrates; mutate is acked and broadcast optimistically", () =>
    Effect.gen(function* () {
      const { engine, store } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tab, mutators });

      yield* mirror.subscribe(allTodos);
      // The mutate ack means the host journaled it (optimistic write).
      yield* mirror.mutate("todo/set", { id: "1", title: "from the tab", done: false });

      const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["from the tab"]);

      // The journal lives in the host, not the tab.
      expect(yield* store.pendingMutations).toHaveLength(1);
      yield* engine.push;
      yield* engine.pull;
      // Confirmed rows keep flowing to the mirror after the rebase.
      const confirmed = yield* eventually(
        mirror.query(allTodos),
        (current) => current.length === 1
      );
      expect(confirmed.map((row) => (row.value as Todo).title)).toEqual(["from the tab"]);
    })
  );

  it.effect("a second mirror hydrates an already-active subset", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });

      const first = yield* TabMirror.make({ channel: tab, mutators });
      yield* first.subscribe(allTodos);
      yield* first.mutate("todo/set", { id: "1", title: "before", done: false });
      yield* eventually(first.query(allTodos), (current) => current.length === 1);

      // Loopback broadcasts reach every subscriber on the tab side, so a
      // late mirror on the same channel hydrates from the re-broadcast.
      const second = yield* TabMirror.make({ channel: tab, mutators });
      yield* second.subscribe(allTodos);
      const rows = yield* eventually(second.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["before"]);
    })
  );

  it.effect("invalid args fail in the tab; host validation errors come back", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tab, mutators });

      const local = yield* Effect.flip(mirror.mutate("todo/set", { id: 1 }));
      expect(local._tag).toBe("MutatorError");

      const unknown = yield* Effect.flip(mirror.mutate("todo/unknown", {}));
      expect(unknown._tag).toBe("MutatorError");
    })
  );

  it.effect("foreign traffic on the channel is ignored", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tab, mutators });

      yield* tab.post({ some: "other library's message" });
      yield* tab.post("not even an object");
      yield* mirror.subscribe(allTodos);
      yield* mirror.mutate("todo/set", { id: "1", title: "still works", done: false });
      yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
    })
  );
});

describe("EngineHost subset refcounting", () => {
  it.effect("keeps a subset until its last tab leaves; disconnect releases it", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const subs = yield* Ref.make(0);
      const unsubs = yield* Ref.make(0);
      // Count engine subscribe/unsubscribe; delegate everything else.
      const counted = {
        ...engine,
        subscribe: (subset) =>
          Ref.update(subs, (n) => n + 1).pipe(Effect.andThen(engine.subscribe(subset))),
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted });
      const one = yield* TabMirror.make({ channel: tab, mutators });

      // Two tabs share the same subset: one engine subscription.
      yield* one.subscribe(allTodos);
      yield* eventually(Ref.get(subs), (n) => n === 1);
      const two = yield* Effect.scoped(
        Effect.gen(function* () {
          const second = yield* TabMirror.make({ channel: tab, mutators });
          yield* second.subscribe(allTodos);
          // No second engine subscription, no teardown while both are present.
          yield* sleepReal(30);
          expect(yield* Ref.get(subs)).toBe(1);
          expect(yield* Ref.get(unsubs)).toBe(0);
          return "scoped";
        })
      );
      expect(two).toBe("scoped");

      // The second tab's scope closed → Disconnect released its hold, but
      // the first tab still holds the subset, so no teardown yet.
      yield* sleepReal(30);
      expect(yield* Ref.get(unsubs)).toBe(0);

      // The last tab explicitly unsubscribes → the engine subscription ends.
      yield* one.unsubscribe(allTodos);
      yield* eventually(Ref.get(unsubs), (n) => n === 1);
    })
  );
});

describe("EngineHost liveness (heartbeat)", () => {
  const liveness = { tabTimeout: "60 millis", sweepInterval: "15 millis" } as const;

  // Real clock: heartbeat/sweep run on Effect.sleep, which the TestClock
  // would freeze. `it.live` uses wall time, so the short intervals fire.
  it.live("reclaims a subset from a tab that stops heartbeating", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const unsubs = yield* Ref.make(0);
      const counted = {
        ...engine,
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted, liveness });

      // A "ghost" tab subscribes directly on the channel and never
      // heartbeats — modelling a crashed tab that can't send Disconnect.
      yield* tab.post({ _tag: "Subscribe", tabId: "ghost", subset: allTodos });

      // The sweep reclaims it once its last-seen passes the timeout.
      yield* eventually(Ref.get(unsubs), (n) => n === 1);
    })
  );

  it.live("keeps a live tab's subset across several sweeps", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const unsubs = yield* Ref.make(0);
      const counted = {
        ...engine,
        unsubscribe: (subset) =>
          Ref.update(unsubs, (n) => n + 1).pipe(Effect.andThen(engine.unsubscribe(subset))),
      } satisfies typeof engine;

      const { host, tab } = yield* MirrorChannel.makeLoopbackPair;
      yield* EngineHost.run({ channel: host, engine: counted, liveness });
      // A real mirror heartbeats faster than the timeout.
      const mirror = yield* TabMirror.make({
        channel: tab,
        mutators,
        heartbeatInterval: "15 millis",
      });
      yield* mirror.subscribe(allTodos);
      yield* eventually(mirror.query(allTodos), (current) => current.length === 0);

      // Across several timeout windows the heartbeat keeps it alive.
      yield* Effect.sleep("200 millis");
      expect(yield* Ref.get(unsubs)).toBe(0);
    })
  );
});

describe("EngineHost ↔ TabMirror (BroadcastChannel)", () => {
  it.effect("syncs tab to host over a real BroadcastChannel pair", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const name = `legation-test-${Date.now()}`;
      const host = yield* MirrorChannel.makeBroadcastChannel(name);
      const tabChannel = yield* MirrorChannel.makeBroadcastChannel(name);
      yield* EngineHost.run({ channel: host, engine });
      const mirror = yield* TabMirror.make({ channel: tabChannel, mutators });

      yield* mirror.subscribe(allTodos);
      yield* mirror.mutate("todo/set", { id: "1", title: "broadcast", done: false });
      const rows = yield* eventually(mirror.query(allTodos), (current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["broadcast"]);
    })
  );
});
