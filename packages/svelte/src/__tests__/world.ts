/**
 * Shared test world: a real engine over the in-memory stack (memory backend,
 * in-process sync room, loopback transport, memory client store) — the same
 * composition the React binding tests use, packaged as the `ManagedRuntime`
 * the Svelte context helpers expect.
 */
import { flushSync } from "svelte";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Collection,
  Edge,
  MemoryBackend,
  MutationRejected,
  Mutator,
  Node,
  Predicate,
  Query,
  Transport,
} from "@legation/effect";
import { ClientEngine, ClientView, Subset, SyncRoom } from "@legation/effect/internal";

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly authorId?: string;
}

export interface User {
  readonly id: string;
  readonly name: string;
}

/**
 * The node graph (ADR-0022): todos reference their author (`one` edge over
 * `authorId`); users carry the inverse dependent collection. The engine
 * registry derives from it.
 */
export const nodes = Node.registry([
  Node.make("users", {
    attributes: { name: Schema.String },
    edges: { todos: Edge.many("todos", { inverse: "author" }) },
  }),
  Node.make("todos", {
    attributes: { title: Schema.String },
    edges: { author: Edge.one("users", { via: "authorId" }) },
  }),
]);

/** The derived engine registry (store-API tests still consume it). */
export const collections: Collection.CollectionRegistry = nodes.collections;

export const mutators = Mutator.registry([
  {
    mutator: Mutator.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
  {
    mutator: Mutator.make("user/set", Schema.Unknown),
    local: (args, writer) => writer.put("users", (args as User).id, args),
  },
  {
    // Optimistically applied, permanently rejected by the backend — the
    // overlay row must disappear on the rebase that observes the rejection.
    mutator: Mutator.make("todo/reject", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
  "user/set": (args, writer) => Effect.asVoid(writer.put("users", (args as User).id, args)),
  "todo/reject": () => Effect.fail(new MutationRejected({ reason: "not allowed" })),
};

const queries = Query.registry([
  {
    query: Query.make("todos/byTitle", Schema.Struct({ title: Schema.String })),
    local: (args: { readonly title: string }) =>
      Subset.make({ collection: "todos", where: Predicate.eq("title", args.title) }),
  },
]);

export const engineLayer = ClientEngine.layer({
  clientId: "c1",
  clientGroupId: "group-1",
  mutators,
  queries,
}).pipe(
  Layer.provide(
    Transport.layerInMemory("group-1").pipe(
      Layer.provide(
        SyncRoom.layer.pipe(
          Layer.provide(Layer.effect(Backend.Backend)(MemoryBackend.make(handlers))),
          Layer.provide(
            Layer.succeed(Authorization.AuthPolicy)(
              Authorization.policy({
                todos: Authorization.allowAll,
                users: Authorization.allowAll,
              })
            )
          )
        )
      )
    )
  ),
  Layer.provide(ClientStore.layerMemory)
);

/**
 * The tests' runtime carries both the narrow view (what the bindings consume)
 * and the full engine (what the tests drive push/pull through) — the same
 * composition an engine-backed app uses.
 */
export type WorldRuntime = ManagedRuntime.ManagedRuntime<
  ClientView.ClientView | ClientEngine.ClientEngine,
  never
>;

/** A fresh, isolated engine runtime per test. Dispose it when done. */
export const makeRuntime = (): WorldRuntime =>
  ManagedRuntime.make(ClientView.layer.pipe(Layer.provideMerge(engineLayer)));

/**
 * The rune hooks' runtime: the {@link Client.Client} over the same engine,
 * with the engine alongside for tests that drive push/pull directly.
 */
export type ClientWorldRuntime = ManagedRuntime.ManagedRuntime<
  Client.Client | ClientEngine.ClientEngine,
  never
>;

/** A fresh Client runtime per test. Dispose it when done. */
export const makeClientRuntime = (): ClientWorldRuntime =>
  ManagedRuntime.make(
    Layer.effect(Client.Client)(
      Effect.map(ClientEngine.ClientEngine, (engine) =>
        Client.fromView(nodes, ClientView.fromEngine(engine))
      )
    ).pipe(Layer.provideMerge(engineLayer))
  );

/** Run an effect against the runtime's engine (any engine-carrying runtime). */
export const run = <A, E, R = never>(
  runtime: ManagedRuntime.ManagedRuntime<ClientEngine.ClientEngine | R, never>,
  f: (engine: ClientEngine.ClientEngine) => Effect.Effect<A, E>
): Promise<A> => runtime.runPromise(Effect.flatMap(ClientEngine.ClientEngine, f));

/**
 * Poll until a condition holds, flushing Svelte's pending effects between
 * checks so store emissions from engine fibers reach the DOM.
 */
export const until = async (predicate: () => boolean, timeoutMs = 25_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    flushSync();
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("until: timed out waiting for condition");
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Find a rendered button by its exact label. */
export const buttonByLabel = (label: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  );
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  return button;
};
