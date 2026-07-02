/**
 * Typed-query surface (#37):
 *
 * - Canonical arg keys: two structurally-equal args objects with different key
 *   order resolve to the same named-query subscription entry and the same Atom.
 * - `select` projection on `observe`: re-emits only when the projected value
 *   changes (a mutation to a field the projection ignores does not re-emit).
 * - Typed subset builder + trust-cast typed reads: the row type flows through
 *   `query`/`observe` without user casts (compile-time, plus a runtime smoke).
 * - Type-level rejections of unknown fields / mismatched literals, enforced by
 *   the typecheck gate via `@ts-expect-error`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Collection from "../Collection.js";
import * as Cvr from "../Cvr.js";
import * as EngineAtoms from "../EngineAtoms.js";
import * as Hash from "../Hash.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import type { PullRequest, PullResponse, PushResponse } from "../Protocol.js";
import * as Query from "../Query.js";
import * as Subset from "../Subset.js";
import * as SyncRoom from "../SyncRoom.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, layerInMemory, makeInMemory, type ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

const TodoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
const todos = Collection.make({ name: "todos", schema: TodoSchema, id: (r) => r.id });

const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);
const backendHandlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<ServerHandler, never, any> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(backendHandlers);
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(
      Authorization.AuthPolicy,
      Authorization.policy({ todos: Authorization.allowAll })
    ),
    Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
    Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
  );
});

const makeEngine = Effect.gen(function* () {
  const handler = yield* makeServer;
  const store = yield* ClientStoreModule.makeMemory;
  const transport = yield* makeInMemory(handler, "group-a");
  const engine = yield* ClientEngineModule.make({
    clientId: "client-a",
    clientGroupId: "group-a",
    mutators,
  }).pipe(
    Effect.provideService(ClientStore, store),
    Effect.provideService(ClientTransport, transport)
  );
  return { engine, store };
});

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

// ─── A. Canonical arg keys ─────────────────────────────────────────────────────

describe("canonical arg keys", () => {
  it("canonicalJson is key-order-insensitive but value-sensitive", () => {
    expect(Hash.canonicalJson({ a: 1, b: 2 })).toBe(Hash.canonicalJson({ b: 2, a: 1 }));
    expect(Hash.canonicalJson({ a: { x: 1, y: 2 } })).toBe(
      Hash.canonicalJson({ a: { y: 2, x: 1 } })
    );
    expect(Hash.canonicalJson({ a: 1, b: 2 })).not.toBe(Hash.canonicalJson({ a: 1, b: 3 }));
  });

  it("EngineAtoms.namedQuery yields the same Atom whatever the args key order", () => {
    // The engine is never instantiated here — we only compare Atom identity,
    // which is decided by the canonical key before any mount.
    const engineLayer = ClientEngineModule.layer({
      clientId: "c1",
      clientGroupId: "group-1",
      mutators,
    }).pipe(
      Layer.provide(
        layerInMemory("group-1").pipe(
          Layer.provide(
            SyncRoom.layer.pipe(
              Layer.provide(MemoryBackend.layer(backendHandlers)),
              Layer.provide(
                Layer.succeed(Authorization.AuthPolicy)(
                  Authorization.policy({ todos: Authorization.allowAll })
                )
              )
            )
          )
        )
      ),
      Layer.provide(ClientStoreModule.layerMemory)
    );
    const atoms = EngineAtoms.fromLayer(engineLayer);
    expect(atoms.namedQuery("q", { a: 1, b: 2 })).toBe(atoms.namedQuery("q", { b: 2, a: 1 }));
    expect(atoms.namedQuery("q", { a: 1 })).not.toBe(atoms.namedQuery("q", { a: 2 }));
  });

  it.effect("reordered named-subscription args collapse to one subscription entry", () =>
    Effect.gen(function* () {
      const QueryArgs = Schema.Struct({ done: Schema.Boolean, limit: Schema.Number });
      const byDone = Query.make("todos/byDone", QueryArgs);
      const queries = Query.registry([
        {
          query: byDone,
          local: (args: typeof QueryArgs.Type) =>
            Subset.make({
              collection: "todos",
              where: Predicate.eq("done", args.done),
              limit: args.limit,
            }),
        },
      ]);

      const pulls: Array<PullRequest> = [];
      const recordingTransport: ClientTransport = {
        push: () => Effect.succeed({ lastMutationIds: {} } as PushResponse),
        pull: (request) =>
          Effect.sync(() => {
            pulls.push(request);
            return { cookie: "c1", patch: [], lastMutationIds: {} } satisfies PullResponse;
          }),
        pokes: Stream.empty,
        status: Effect.succeed("connected"),
        statusChanges: Stream.empty,
      };

      const store = yield* ClientStoreModule.makeMemory;
      const engine = yield* ClientEngineModule.make({
        clientId: "client-a",
        clientGroupId: "group-a",
        mutators,
        queries,
      }).pipe(
        Effect.provideService(ClientStore, store),
        Effect.provideService(ClientTransport, recordingTransport)
      );

      // Same logical subscription, args written in two key orders.
      yield* engine.subscribeQuery("todos/byDone", { done: false, limit: 10 });
      yield* engine.subscribeQuery("todos/byDone", { limit: 10, done: false });
      yield* engine.pull;

      const lastPull = pulls.at(-1);
      expect(lastPull?.namedSubscriptions).toHaveLength(1);
    })
  );
});

// ─── B/C. Typed builder + trust-cast reads ─────────────────────────────────────

describe("typed subset builder + reads", () => {
  it.effect("Subset.for(...).make flows the row type through query without casts", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      const openTodos = Subset.for(todos).make({
        where: (p) => p.eq("done", false),
        orderBy: [{ field: "title", direction: "asc" }],
      });
      yield* engine.subscribe(openTodos);

      yield* engine.mutate("todo/set", { id: "1", title: "typed", done: false });

      const rows = yield* engine.query(openTodos);
      // No cast: `value` is `Todo`, so `.title` / `.done` are typed access.
      expect(rows.map((row) => row.value.title)).toEqual(["typed"]);
      expect(rows[0]?.value.done).toBe(false);
    })
  );

  it("the builder erases to a plain Subset at runtime", () => {
    const built = Subset.for(todos).make({ where: (p) => p.eq("done", true), limit: 5 });
    expect(built).toEqual(
      Subset.make({ collection: "todos", where: Predicate.eq("done", true), limit: 5 })
    );
  });

  // Type-level: enforced by the typecheck gate. Each `@ts-expect-error` must
  // sit on a line that genuinely fails to compile, or the gate fails.
  it("rejects unknown fields and mismatched literals at compile time", () => {
    Subset.for(todos).make({
      // @ts-expect-error unknown field name is rejected
      where: (p) => p.eq("nope", false),
    });
    Subset.for(todos).make({
      // @ts-expect-error a boolean field rejects a string literal
      where: (p) => p.eq("done", "not-a-boolean"),
    });
    Subset.for(todos).make({
      // @ts-expect-error unknown orderBy field is rejected
      orderBy: [{ field: "nope", direction: "asc" }],
    });
    expect(true).toBe(true);
  });
});

// ─── D. select projection on observe ───────────────────────────────────────────

describe("observe select projection", () => {
  const allTodos = Subset.for(todos).make({ orderBy: [{ field: "id", direction: "asc" }] });

  it.effect("re-emits only when the projected value changes", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeEngine;
      yield* engine.subscribe(allTodos);

      const emissions = yield* Ref.make<ReadonlyArray<string>>([]);
      // Projection ignores `done`: it is the concatenation of the titles.
      const projected = engine.observe(allTodos, {
        select: (rows) => rows.map((row) => row.value.title).join("|"),
      });
      const fiber = yield* Effect.forkScoped(
        Stream.runForEach(projected, (value) =>
          Ref.update(emissions, (current) => [...current, value])
        )
      );

      const settle = sleepReal(30);
      yield* settle; // initial empty projection ("")
      yield* engine.mutate("todo/set", { id: "1", title: "a", done: false });
      yield* settle;
      // Mutating a field the projection ignores must NOT re-emit.
      yield* engine.mutate("todo/set", { id: "1", title: "a", done: true });
      yield* settle;
      // Mutating a projected field must re-emit.
      yield* engine.mutate("todo/set", { id: "1", title: "b", done: true });
      yield* settle;

      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(emissions)).toEqual(["", "a", "b"]);
    })
  );
});
