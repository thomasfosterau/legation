/**
 * Predicate-aware fan-out matching (#42): a committed write pokes a client
 * group only when some hinted change plausibly affects one of its
 * subscriptions. Soundness first — over-matching is safe (a redundant poke
 * costs an empty pull), under-matching would delay convergence — so a
 * value-less hint or an `Exists` predicate falls back to a collection-level
 * match, and a delete matches against the rows a group's CVR actually holds.
 *
 * The fan-out fibre pokes asynchronously, so each case waits for the fan-out to
 * finish the hint batch it was handed (its per-batch latency sample), then reads
 * the `legation_pokes*` deltas. Nothing here reads the wall clock. A group that
 * must be poked is confirmed by its hub's replayed poke; a group that must NOT
 * be poked is confirmed by the poke total, since each case publishes one batch
 * and the poked group accounts for the whole total.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import type { ChangeHint } from "../Backend.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import * as Telemetry from "../Telemetry.js";
import type { ServerHandler } from "../Transport.js";

interface Todo {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
}

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "todo/remove": (args, writer) => writer.del("todos", (args as { id: string }).id),
};

const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

/** A server exposing its bus so tests can publish raw (value-less) hints. */
const makeServer: Effect.Effect<
  { readonly handler: ServerHandler; readonly bus: InvalidationBus.InvalidationBus },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  const handler = yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, authPolicy),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
  return { handler, bus };
});

const allTodos = Subset.make({ collection: "todos" });
const tenant = (id: string) =>
  Subset.make({ collection: "todos", where: Predicate.eq("tenantId", id) });

const pushSet = (group: string, client: string, mutationId: number, row: Todo) => ({
  clientGroupId: group,
  mutations: [{ clientId: client, mutationId, mutator: "todo/set", args: row, createdAt: 0 }],
});

const pushRemove = (group: string, client: string, mutationId: number, id: string) => ({
  clientGroupId: group,
  mutations: [{ clientId: client, mutationId, mutator: "todo/remove", args: { id }, createdAt: 0 }],
});

const subscribe = (handler: ServerHandler, group: string, subset: Subset.Subset) =>
  handler.handlePull({ clientGroupId: group, cookie: undefined, subscriptions: [subset] });

/** Snapshot the poke counters, for before/after deltas. */
const counts = Effect.all({
  poked: Metric.value(Telemetry.pokesTotal),
  suppressed: Metric.value(Telemetry.pokesSuppressedTotal),
});

/** How many hint batches the fan-out has finished deciding. */
const decidedBatches = Metric.value(Telemetry.fanoutLatencyMs).pipe(
  Effect.map((state) => state.count)
);

/**
 * Wait until the fan-out has decided the batch published after `before` was
 * read. It records one latency sample per batch, after its last group is poked
 * or suppressed, so the sample advancing is the batch-done event (this relies
 * on SyncServer recording the sample after its poke loop). The loop
 * yields between reads; it never waits on a timer, and a fan-out that never
 * decides the batch fails at the runner's timeout.
 */
const awaitBatch = (before: number) =>
  Effect.gen(function* () {
    while ((yield* decidedBatches) <= before) yield* Effect.yieldNow;
  });

/** Publish one batch, wait for the fan-out to decide it, and return the poke deltas it caused. */
const fanoutDeltas = <E>(publish: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const batchesBefore = yield* decidedBatches;
    const before = yield* counts;
    yield* publish;
    yield* awaitBatch(batchesBefore);
    const after = yield* counts;
    return {
      poked: after.poked.count - before.poked.count,
      suppressed: after.suppressed.count - before.suppressed.count,
    };
  });

/** Whether the group's hub holds a poke: a late subscriber gets the group's last poke replayed. */
const wasPoked = (handler: ServerHandler, group: string) =>
  Stream.runHead(handler.pokes(group)).pipe(Effect.map(Option.isSome));

describe("predicate-aware fan-out matching (#42)", () => {
  it.effect("pokes only the group whose predicate the write matches", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeServer;
      yield* subscribe(handler, "group-a", tenant("a"));
      yield* subscribe(handler, "group-b", tenant("b"));

      // A write whose row matches group A's predicate but not group B's.
      const deltas = yield* fanoutDeltas(
        handler.handlePush(pushSet("group-w", "c-w", 1, { id: "1", tenantId: "a", title: "x" }))
      );

      // Exactly one poke (A) and one suppression (B, disjoint predicate).
      expect(deltas).toEqual({ poked: 1, suppressed: 1 });
      // The one poke went to A, so B, which the batch never poked, stays quiet.
      expect(yield* wasPoked(handler, "group-a")).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect("a value-less hint falls back to a collection-level match", () =>
    Effect.gen(function* () {
      const { handler, bus } = yield* makeServer;
      yield* subscribe(handler, "group-a", tenant("a"));
      yield* subscribe(handler, "group-b", tenant("b"));

      // No `values`: the server cannot decide by predicate, so it pokes every
      // group subscribed to the collection (both A and B, disjoint predicates).
      const deltas = yield* fanoutDeltas(bus.publish([{ collection: "todos", ids: ["z"] }]));

      expect(deltas).toEqual({ poked: 2, suppressed: 0 });
    }).pipe(Effect.scoped)
  );

  it.effect("an Exists predicate is poked on any change to its collection", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeServer;
      const withExists = Subset.make({
        collection: "todos",
        where: Predicate.exists({
          collection: "tenants",
          localField: "tenantId",
          foreignField: "id",
        }),
      });
      yield* subscribe(handler, "group-e", withExists);

      // A single row can't decide an Exists, so the group is poked regardless
      // of the row's value (conservative match), never suppressed.
      const deltas = yield* fanoutDeltas(
        handler.handlePush(
          pushSet("group-w", "c-w", 1, { id: "1", tenantId: "unmatched", title: "x" })
        )
      );

      expect(deltas).toEqual({ poked: 1, suppressed: 0 });
      expect(yield* wasPoked(handler, "group-e")).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect("a delete pokes a group whose CVR holds the row (CVR-precise)", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeServer;
      // Seed a row and let its hint drain before any group subscribes, so the
      // seed does not race the subscriptions and skew the counters.
      yield* fanoutDeltas(
        handler.handlePush(pushSet("group-w", "c-w", 1, { id: "1", tenantId: "a", title: "x" }))
      );
      // group-holder syncs the row (its CVR now holds todos/1); group-other, on
      // a disjoint predicate, holds nothing.
      yield* subscribe(handler, "group-holder", allTodos);
      yield* subscribe(handler, "group-other", tenant("other"));

      // Delete row 1: its id is in the hint's ids but absent from its values.
      const deltas = yield* fanoutDeltas(handler.handlePush(pushRemove("group-w", "c-w", 2, "1")));

      // Only the group whose CVR held the row is poked; the other is suppressed.
      expect(deltas).toEqual({ poked: 1, suppressed: 1 });
      expect(yield* wasPoked(handler, "group-holder")).toBe(true);
    }).pipe(Effect.scoped)
  );

  it.effect("value-less and value-carrying hints round-trip through the wire schema", () =>
    Effect.gen(function* () {
      const broker = yield* InvalidationBus.makeMemoryBroker;
      const bus = InvalidationBus.makeSerialized(broker);
      const subscription = yield* bus.subscribe;

      // An old, value-less hint must decode and behave exactly as before.
      const valueLess: ReadonlyArray<ChangeHint> = [{ collection: "todos", ids: ["1", "2"] }];
      yield* bus.publish(valueLess);
      expect(yield* subscription.take).toEqual(valueLess);

      // A value-carrying hint round-trips its row values intact.
      const valueCarrying: ReadonlyArray<ChangeHint> = [
        { collection: "todos", ids: ["1"], values: [{ id: "1", value: { tenantId: "a" } }] },
      ];
      yield* bus.publish(valueCarrying);
      expect(yield* subscription.take).toEqual(valueCarrying);
    }).pipe(Effect.scoped)
  );
});
