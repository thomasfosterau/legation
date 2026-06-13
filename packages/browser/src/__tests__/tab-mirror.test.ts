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
} from "@thomasfosterau/effect-sync-core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
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

describe("EngineHost ↔ TabMirror (BroadcastChannel)", () => {
  it.effect("syncs tab to host over a real BroadcastChannel pair", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const name = `effect-sync-test-${Date.now()}`;
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
