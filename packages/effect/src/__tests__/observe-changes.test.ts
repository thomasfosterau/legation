/**
 * ClientEngine.observeChanges / Mirror.observeChanges (#115): row-level
 * enter/update/exit deltas over a subset's live window, batched per
 * view-step. Anchored to `observeSubset`'s existing Patch/Rebuild/gap-collapse
 * machinery (`backpressure.test.ts`, `incremental.test.ts`) so these tests
 * exercise the same three paths at the delta level:
 *
 * - an empty-journal pull applies a `Patch` → a diffed batch (enter/update/exit);
 * - a local mutation (or any overlay-shifting change) is a `Rebuild` → a
 *   `reset` marker + fresh `enter`s;
 * - a dropped change (bounded hub under pressure) collapses into a `Rebuild`
 *   too, so it also resets rather than silently losing a delta.
 *
 * `Mirror.observeChanges` has no incremental `LiveView`: it diffs consecutive
 * whole-page `MirrorUpdate`s, so its own suite checks the same three
 * semantics land correctly from page diffing alone.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as EngineHost from "../EngineHost.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as MirrorChannel from "../MirrorChannel.js";
import * as MirrorModule from "../Mirror.js";
import * as Mutator from "../Mutator.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
  {
    mutator: Mutator.make("todo/remove", Schema.Unknown),
    local: (args, writer) => writer.del("todos", (args as { id: string }).id),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/remove": (args, writer) => Effect.asVoid(writer.del("todos", (args as { id: string }).id)),
};

const makeServer = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (handler: ServerHandler, group: string, changeHubCapacity?: number) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, group);
    return yield* ClientEngineModule.make({
      clientId: group,
      clientGroupId: group,
      mutators,
      ...(changeHubCapacity === undefined ? {} : { changeHubCapacity }),
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const todos = Subset.make({ collection: "todos" });
const settle = Effect.sleep(Duration.millis(50));

const collect = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const batches = yield* Ref.make<Array<A>>([]);
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (b) => Ref.update(batches, (a) => [...a, b]))
    );
    return batches;
  });

describe("ClientEngine.observeChanges", () => {
  it("Patch path: enter, then update, then exit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");
        yield* reader.subscribe(todos);

        const batches = yield* collect(reader.observeChanges(todos));
        yield* settle;
        expect(yield* Ref.get(batches)).toEqual([]); // includeInitial defaults to false

        yield* writer.mutate("todo/set", { id: "1", title: "first" });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;

        yield* writer.mutate("todo/set", { id: "1", title: "second" });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;

        yield* writer.mutate("todo/remove", { id: "1" });
        yield* writer.push;
        yield* reader.pull;
        yield* settle;

        const seen = yield* Ref.get(batches);
        expect(seen).toHaveLength(3);
        expect(seen[0]).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "first" } } },
        ]);
        expect(seen[1]).toEqual([
          {
            _tag: "update",
            row: { id: "1", value: { id: "1", title: "second" } },
            previous: { id: "1", value: { id: "1", title: "first" } },
          },
        ]);
        expect(seen[2]).toEqual([
          { _tag: "exit", id: "1", previous: { id: "1", value: { id: "1", title: "second" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("includeInitial emits the current window as enters, exactly once, for a late subscriber", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const writer = yield* makeClient(handler, "writer");
        const reader = yield* makeClient(handler, "reader");
        yield* reader.subscribe(todos);

        yield* writer.mutate("todo/set", { id: "1", title: "a" });
        yield* writer.mutate("todo/set", { id: "2", title: "b" });
        yield* writer.push;
        yield* reader.pull; // rows already present before anyone observes

        const batches = yield* collect(reader.observeChanges(todos, { includeInitial: true }));
        yield* settle;

        const seen = yield* Ref.get(batches);
        expect(seen).toHaveLength(1); // one batch: the initial enters, no gap/dup
        expect(
          new Set((seen[0] ?? []).map((c) => (c._tag === "enter" ? c.row.id : undefined)))
        ).toEqual(new Set(["1", "2"]));
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("Rebuild path (a local mutation): a reset marker followed by fresh enters", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "solo");
        yield* engine.subscribe(todos);

        const batches = yield* collect(engine.observeChanges(todos));
        yield* settle;

        yield* engine.mutate("todo/set", { id: "1", title: "optimistic" });
        yield* settle;

        const seen = yield* Ref.get(batches);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.[0]).toEqual({ _tag: "reset" });
        expect(seen[0]?.slice(1)).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "optimistic" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("a seq-gap collapse resets rather than losing the dropped deltas", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeClient(handler, "storm", 4); // small bound → forced drops
        yield* engine.subscribe(todos);

        const batches = yield* collect(engine.observeChanges(todos));
        yield* settle;

        // A burst of local mutations far exceeding the bounded hub's capacity.
        yield* Effect.forEach(Array.from({ length: 30 }), (_, i) =>
          engine.mutate("todo/set", { id: `s${i}`, title: `t${i}` })
        );
        yield* settle;

        const seen = yield* Ref.get(batches);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.some((batch) => batch[0]?._tag === "reset")).toBe(true);

        // Folding every received batch reproduces the engine's own query.
        const folded = new Map<string, unknown>();
        for (const batch of seen) {
          for (const change of batch) {
            if (change._tag === "reset") folded.clear();
            else if (change._tag === "enter" || change._tag === "update") {
              folded.set(change.row.id, change.row.value);
            } else if (change._tag === "exit") folded.delete(change.id);
          }
        }
        const expected = yield* engine.query(todos);
        expect([...folded.keys()].toSorted()).toEqual(expected.map((r) => r.id).toSorted());
      }).pipe(Effect.scoped)
    );
  }, 10000);
});

describe("Mirror.observeChanges", () => {
  const makeEngine = (handler: ServerHandler) =>
    Effect.gen(function* () {
      const store = yield* ClientStoreModule.makeMemory;
      const transport = yield* makeInMemory(handler, "group-host");
      return yield* ClientEngineModule.make({
        clientId: "host",
        clientGroupId: "group-host",
        mutators,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, transport)
      );
    });

  it("diffs consecutive whole-page mirror updates into enter/update/exit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeEngine(handler);
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine });
        const mirror = yield* MirrorModule.make({ channel: pair.mirror, mutators });

        const batches = yield* collect(mirror.observeChanges(todos));
        yield* mirror.subscribe(todos);
        yield* settle;

        yield* mirror.mutate("todo/set", { id: "1", title: "first" });
        yield* settle;
        yield* mirror.mutate("todo/set", { id: "1", title: "second" });
        yield* settle;
        yield* mirror.mutate("todo/remove", { id: "1" });
        yield* settle;

        const seen = (yield* Ref.get(batches)).filter((b) => b.length > 0);
        const tags = seen.map((batch) => batch.map((c) => c._tag));
        expect(tags).toEqual([["enter"], ["update"], ["exit"]]);
      }).pipe(Effect.scoped)
    );
  }, 10000);

  it("includeInitial emits current rows as enters for a late subscriber", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* makeServer;
        const engine = yield* makeEngine(handler);
        const pair = yield* MirrorChannel.makeLoopbackPair;
        yield* EngineHost.run({ channel: pair.host, engine });
        const mirror = yield* MirrorModule.make({ channel: pair.mirror, mutators });

        yield* mirror.subscribe(todos);
        yield* mirror.mutate("todo/set", { id: "1", title: "a" });
        yield* settle;

        const batches = yield* collect(mirror.observeChanges(todos, { includeInitial: true }));
        yield* settle;

        const seen = yield* Ref.get(batches);
        expect(seen[0]).toEqual([
          { _tag: "enter", row: { id: "1", value: { id: "1", title: "a" } } },
        ]);
      }).pipe(Effect.scoped)
    );
  }, 10000);
});
