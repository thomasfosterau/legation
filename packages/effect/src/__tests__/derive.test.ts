/**
 * Derive tests: the streaming face of the derived-combinator tier.
 *
 * - **Composition** — the output of one combinator serves as the source of
 *   another (queries-from-queries), maintained end-to-end; the final derived
 *   page matches a hand-computed expected result.
 * - **Teardown** — a pipeline's leaf holds a refcounted `Subscriptions` handle
 *   and releases it when its scope closes (observed behaviorally, like
 *   `Subscriptions`' own test: once released and the grace elapses, the next
 *   pull drops the rows).
 * - **Observability** — a derived pipeline exposed via `Derive.atom` re-emits
 *   over the engine's change stream, so a framework binding needs nothing new.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as ClientView from "../ClientView.js";
import * as Cvr from "../Cvr.js";
import * as Derive from "../Derive.js";
import * as Hash from "../Hash.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Subscriptions from "../Subscriptions.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

type Row = Derive.Row;
const page = (rows: ReadonlyArray<Row>): ReadonlyArray<{ id: string; value: unknown }> =>
  rows.map((row) => ({ id: row.id, value: row.value }));

/** Compare a derived page by (id, canonical value) — order-sensitive. */
const canonicalPage = (rows: ReadonlyArray<Row>): ReadonlyArray<readonly [string, string]> =>
  rows.map((row) => [row.id, Hash.canonicalJson(row.value)] as const);

const source = (...pages: ReadonlyArray<ReadonlyArray<Row>>): Derive.Source<never> =>
  Stream.fromIterable(pages);

const lastEmission = <A>(stream: Stream.Stream<A, never>): Effect.Effect<A> =>
  Stream.runCollect(stream).pipe(Effect.map((all) => all[all.length - 1]!));

describe("Derive — composition (queries-from-queries)", () => {
  it.effect("filter → map → orderedWindow, maintained across snapshots", () =>
    Effect.gen(function* () {
      const p1: ReadonlyArray<Row> = [
        { id: "1", value: { n: 3, name: "c" } },
        { id: "2", value: { n: 7, name: "a" } },
        { id: "3", value: { n: 5, name: "b" } },
      ];
      // id 3 removed; id 1's n crosses the filter threshold (3 → 9).
      const p2: ReadonlyArray<Row> = [
        { id: "1", value: { n: 9, name: "c" } },
        { id: "2", value: { n: 7, name: "a" } },
      ];
      const pipeline = Derive.orderedWindow(
        Derive.map(
          Derive.filter(source(p1, p2), (v) => (v as { n: number }).n >= 5),
          (v) => ({ name: (v as { name: string }).name, n: (v as { n: number }).n })
        ),
        { orderBy: [{ field: "name", direction: "asc" }], limit: 2 }
      );
      const final = yield* lastEmission(pipeline);
      expect(page(final)).toEqual([
        { id: "2", value: { name: "a", n: 7 } },
        { id: "1", value: { name: "c", n: 9 } },
      ]);
    })
  );

  it.effect("join (left) → map → groupBy — a joined view grouped into rows", () =>
    Effect.gen(function* () {
      const orders: ReadonlyArray<Row> = [
        { id: "o1", value: { cust: "c1" } },
        { id: "o2", value: { cust: "c2" } },
        { id: "o3", value: { cust: "c1" } },
      ];
      const customers: ReadonlyArray<Row> = [
        { id: "c1", value: { cid: "c1", region: "east" } },
        { id: "c2", value: { cid: "c2", region: "west" } },
      ];
      const joined = Derive.join(source(orders), source(customers), {
        leftKey: (v) => (v as { cust: string }).cust,
        rightKey: (v) => (v as { cid: string }).cid,
        kind: "left",
      });
      const byRegion = Derive.groupBy(
        Derive.map(joined, (v) => {
          const right = (v as { right: { region: string } | null }).right;
          return { region: right?.region ?? "none" };
        }),
        (v) => (v as { region: string }).region
      );
      const final = yield* lastEmission(byRegion);
      // Two groups, ordered by key: east has o1+o3, west has o2.
      expect(final.map((row) => row.id)).toEqual(["east", "west"]);
      const east = final.find((row) => row.id === "east")!.value as {
        rows: ReadonlyArray<unknown>;
      };
      const west = final.find((row) => row.id === "west")!.value as {
        rows: ReadonlyArray<unknown>;
      };
      expect(east.rows.length).toBe(2);
      expect(west.rows.length).toBe(1);
    })
  );

  it.effect("distinct collapses duplicate values to one row", () =>
    Effect.gen(function* () {
      const p: ReadonlyArray<Row> = [
        { id: "a", value: { c: "x" } },
        { id: "b", value: { c: "y" } },
        { id: "d", value: { c: "x" } },
      ];
      const final = yield* lastEmission(Derive.distinct(source(p)));
      expect(canonicalPage(final)).toEqual([
        [Hash.canonicalJson({ c: "x" }), Hash.canonicalJson({ c: "x" })],
        [Hash.canonicalJson({ c: "y" }), Hash.canonicalJson({ c: "y" })],
      ]);
    })
  );
});

// ─── Engine-backed tests (teardown + atom observability) ─────────────────────

interface Todo {
  readonly id: string;
  readonly title: string;
}
const TodoArgs = Schema.Struct({ id: Schema.String, title: Schema.String });
const todoSet = Mutator.make("todo/set", TodoArgs);
const mutators = Mutator.registry([
  { mutator: todoSet, local: (args, writer) => writer.put("todos", (args as Todo).id, args) },
]);
const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<ServerHandler, never, import("effect").Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* MemoryBackend.make(handlers);
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, yield* Cvr.makeMemoryStore),
      Effect.provideService(InvalidationBus.InvalidationBus, yield* InvalidationBus.makeInProcess)
    );
  }
);

const makeClient = (handler: ServerHandler) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(handler, "group-1");
    return yield* ClientEngineModule.make({
      clientId: "client-1",
      clientGroupId: "group-1",
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const allTodos = Subset.make({ collection: "todos" });
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id);

const sleepReal = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

describe("Derive — refcounted subscription lifetime", () => {
  it.effect("observed leaf releases its subscription when its scope closes", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* makeServer);
      yield* engine.mutate("todo/set", { id: "1", title: "a" });
      yield* engine.push;
      const subs = yield* Subscriptions.make(engine, { ttl: Duration.minutes(5) });
      const view = ClientView.fromEngine(engine);

      // A derived leaf acquires the subscription for the duration of its scope.
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Acquire the leaf (the stream itself isn't needed — the subscription is).
          yield* Effect.asVoid(Derive.observed(subs, view, allTodos));
          yield* engine.pull;
          expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);
        })
      );

      // Scope closed → released, but still within the TTL grace: rows retained.
      yield* engine.pull;
      expect(ids(yield* engine.query(allTodos))).toEqual(["1"]);

      // Grace elapsed: the whole chain's subscription is gone, next pull drops it.
      yield* TestClock.adjust(Duration.minutes(5));
      yield* engine.pull;
      expect(ids(yield* engine.query(allTodos))).toEqual([]);
    }).pipe(Effect.scoped)
  );
});

describe("Derive — observable via the standard atom surface", () => {
  it.effect("a derived (filtered) pipeline re-emits over the engine change stream", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* makeServer);
      yield* engine.subscribe(allTodos);

      const pipeline = Derive.filter(engine.observe(allTodos), (v) =>
        (v as Todo).title.startsWith("keep")
      );
      const atom = Derive.atom(pipeline);
      const registry = AtomRegistry.make();
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.mount(atom)),
        (unmount) => Effect.sync(unmount)
      );

      const read = Effect.sync(() => registry.get(atom));
      const await1 = (predicate: (rows: ReadonlyArray<Row>) => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = yield* read;
            if (AsyncResult.isSuccess(result) && predicate(result.value)) return result.value;
            yield* sleepReal(5);
          }
          return yield* Effect.die(new Error("derived atom never reached the expected state"));
        });

      yield* await1((rows) => rows.length === 0);

      // Only the "keep-" row survives the client-local filter — the "drop-" row
      // is synced but never shown (the filter shapes, it does not widen sync).
      yield* engine.mutate("todo/set", { id: "1", title: "keep-me" });
      yield* engine.mutate("todo/set", { id: "2", title: "drop-me" });
      const rows = yield* await1((current) => current.length === 1);
      expect(rows.map((row) => (row.value as Todo).title)).toEqual(["keep-me"]);
    })
  );
});

describe("Derive — observed leaf consumes observeChanges (#133 item 1), not page-diff", () => {
  it.effect("a pipeline built on Derive.observed stays correct across enter/update/exit", () =>
    Effect.gen(function* () {
      const engine = yield* makeClient(yield* makeServer);
      const subs = yield* Subscriptions.make(engine, { ttl: Duration.minutes(5) });
      const view = ClientView.fromEngine(engine);

      const pipeline = yield* Derive.observed(subs, view, allTodos).pipe(
        Effect.map((source) => Derive.filter(source, (v) => (v as Todo).title.startsWith("keep")))
      );
      const atom = Derive.atom(pipeline);
      const registry = AtomRegistry.make();
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.mount(atom)),
        (unmount) => Effect.sync(unmount)
      );

      const read = Effect.sync(() => registry.get(atom));
      const await1 = (predicate: (rows: ReadonlyArray<Row>) => boolean) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = yield* read;
            if (AsyncResult.isSuccess(result) && predicate(result.value)) return result.value;
            yield* sleepReal(5);
          }
          return yield* Effect.die(new Error("derived atom never reached the expected state"));
        });

      // Unlike page-based `observe` (which always emits an initial snapshot,
      // even `[]`), `observeChanges({ includeInitial: true })` stays silent
      // until there's something to show (`docs/observing-row-changes.md`) —
      // an empty collection emits no initial batch at all, so the pipeline
      // built on top has nothing to read until the first real change.
      yield* engine.mutate("todo/set", { id: "1", title: "keep-me" });
      yield* engine.mutate("todo/set", { id: "2", title: "drop-me" });
      const afterEnter = yield* await1((current) => current.length === 1);
      expect(afterEnter.map((row) => (row.value as Todo).title)).toEqual(["keep-me"]);

      // An update that crosses the filter boundary the other way: "keep-me"
      // no longer matches, so the pipeline drops back to empty.
      yield* engine.mutate("todo/set", { id: "1", title: "renamed" });
      yield* await1((current) => current.length === 0);

      // And a fresh row entering after that keeps working (the maintained
      // operator state survives past the boundary crossing).
      yield* engine.mutate("todo/set", { id: "3", title: "keep-again" });
      const afterSecondEnter = yield* await1((current) => current.length === 1);
      expect(afterSecondEnter.map((row) => (row.value as Todo).title)).toEqual(["keep-again"]);
    }).pipe(Effect.scoped)
  );
});
