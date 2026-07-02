/**
 * Sync world
 *
 * The whole sync stack, wired up in the page. This is deliberately
 * over-engineered for a demo: rather than a toy request/response, it runs the
 * *real* library server pipeline in-process —
 *
 *   ClientEngine ──(offline-aware loopback transport)──▶ SyncServer
 *        │                                                   │
 *   durable ClientStore (localStorage)                  MemoryBackend
 *        │                                              + CvrStore (CVR diff)
 *   optimistic overlay + journal                        + InvalidationBus (poke)
 *
 * so the demo exercises optimistic writes, the durable journal, push/pull,
 * CVR-diffed patches, poke-driven pulls, and rebase — the same code paths a
 * production deployment uses, minus the network.
 *
 * Three knobs make the behaviour visible:
 *   - `setOnline(false)` makes the transport *fail* push/pull (true offline),
 *     so writes pile up in the durable journal and flush on reconnect.
 *   - `simulateRemote()` writes straight to the backend as a second client,
 *     then pokes — the local engine pulls and rebases, live.
 *   - `pendingNow()` exposes the journal so the UI can show what is unconfirmed.
 */

import { Effect, Schema, Stream, SubscriptionRef } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  InvalidationBus,
  MemoryBackend,
  Mutator,
  type Protocol,
  SyncServer,
  Transport,
  TransportError,
} from "@legation/effect";

import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  RemoveArgs,
  Todo,
  allTodos,
  removeTodo,
  setTodo,
} from "./domain";

/** One unconfirmed journal entry, summarised for display. */
export interface PendingEntry {
  readonly mutationId: number;
  readonly summary: string;
}

/** The handle the FoldKit layer drives. All methods cross into Effect-land. */
export interface SyncWorld {
  /** Live local view of `allTodos` (confirmed rows + optimistic overlay). */
  readonly observeTodos: () => Stream.Stream<ReadonlyArray<Todo>, never>;
  /** Transport connection status, emitted now and on every change. */
  readonly connectionChanges: () => Stream.Stream<Transport.ConnectionStatus, never>;
  /** Snapshot of the durable journal (pending, unconfirmed mutations). */
  readonly pendingNow: () => Promise<ReadonlyArray<PendingEntry>>;
  /** Optimistic write: upsert a todo (also re-run on every rebase). */
  readonly setTodo: (todo: Todo) => Promise<void>;
  /** Optimistic write: delete a todo. */
  readonly removeTodo: (id: string) => Promise<void>;
  /** Flip the transport between online and (failing) offline. */
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Push the journal then pull a patch, right now. */
  readonly syncNow: () => Promise<void>;
  /** Apply an authoritative write as a second client, then poke. */
  readonly simulateRemote: () => Promise<void>;
}

// ─── Mutator handlers ────────────────────────────────────────────────────────

/**
 * Client handlers write to the optimistic overlay. They run once when the
 * mutation is issued and again on every rebase, so they must be idempotent —
 * a `put` keyed by id is.
 */
const clientMutators = Mutator.registry([
  { mutator: setTodo, local: (todo: Todo, writer) => writer.put("todos", todo.id, todo) },
  { mutator: removeTodo, local: (args: RemoveArgs, writer) => writer.del("todos", args.id) },
]);

/**
 * Authoritative handlers run inside the backend's transaction; the engine's
 * push delivers the same intents here. `validatedHandlers` schema-checks the
 * pushed args (untrusted input) before applying them.
 */
const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(setTodo, (todo, writer) => writer.put("todos", todo.id, todo)),
  MemoryBackend.handler(removeTodo, (args, writer) => writer.del("todos", args.id)),
]);

/** Public collection: read auth is allow-all (this demo has no identities). */
const authPolicy = Authorization.policy({ todos: Authorization.allowAll });

// ─── Offline-aware loopback transport ────────────────────────────────────────

/**
 * A {@link Transport.ClientTransport} bound straight to a {@link
 * Transport.ServerHandler}, gated by an `online` flag. When offline, push and
 * pull *fail* (as a real network would) so the engine keeps mutations in the
 * journal; `statusChanges` mirrors the flag so the engine's sync loop pushes +
 * pulls automatically on reconnect.
 */
const makeOfflineTransport = (
  handler: Transport.ServerHandler,
  online: SubscriptionRef.SubscriptionRef<boolean>
): Transport.ClientTransport => {
  const whenOnline = <A>(
    effect: Effect.Effect<A, TransportError>
  ): Effect.Effect<A, TransportError> =>
    SubscriptionRef.get(online).pipe(
      Effect.flatMap((on) =>
        on ? effect : Effect.fail(new TransportError({ message: "Client is offline" }))
      )
    );

  return {
    push: (request) => whenOnline(handler.handlePush(request)),
    pull: (request) => whenOnline(handler.handlePull(request)),
    pokes: handler.pokes(CLIENT_GROUP_ID),
    status: SubscriptionRef.get(online).pipe(
      Effect.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
    statusChanges: SubscriptionRef.changes(online).pipe(
      Stream.map((on): Transport.ConnectionStatus => (on ? "connected" : "disconnected"))
    ),
  };
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const summarise = (mutation: Protocol.Mutation): string =>
  mutation.mutator === "todo/set"
    ? `set "${(mutation.args as Todo).title}"`
    : `remove ${(mutation.args as RemoveArgs).id}`;

/** Seed the in-memory backend so a fresh page always has something to sync. */
const seedBackend = (backend: Backend.Backend, bus: InvalidationBus.InvalidationBus) =>
  Effect.gen(function* () {
    const now = Date.now();
    const seeds: ReadonlyArray<Todo> = [
      { id: "seed-welcome", title: "Welcome — this list is server state", done: false, createdAt: now },
      { id: "seed-offline", title: "Go offline, add todos: they queue in the journal", done: false, createdAt: now + 1 },
      { id: "seed-live", title: 'Hit "Remote edit" to watch a live pull + rebase', done: true, createdAt: now + 2 },
    ];
    let seq = 0;
    for (const todo of seeds) {
      seq += 1;
      const result = yield* backend.applyMutations({ clientGroupId: "seed" }, [
        {
          clientId: "seed",
          mutationId: seq,
          mutator: "todo/set",
          args: Schema.encodeSync(Todo)(todo),
          createdAt: Date.now(),
        },
      ]);
      yield* bus.publish(result.hints);
    }
  });

/**
 * Build the full in-process stack and return a {@link SyncWorld}. The program
 * runs in a forked, never-closing scope so the engine's sync loop and the
 * server's fan-out loop stay alive for the lifetime of the page.
 */
export const createSyncWorld = (): Promise<SyncWorld> =>
  new Promise<SyncWorld>((resolve, reject) => {
    const program = Effect.gen(function* () {
      // Connectivity flag the transport (and the UI) toggle.
      const online = yield* SubscriptionRef.make(true);

      // Server side: backend + CVR store + invalidation bus + sync server.
      const backend = yield* MemoryBackend.make(backendHandlers);
      const cvr = yield* Cvr.makeMemoryStore;
      const bus = yield* InvalidationBus.makeInProcess;
      const handler = yield* SyncServer.make.pipe(
        Effect.provideService(Backend.Backend, backend),
        Effect.provideService(Authorization.AuthPolicy, authPolicy),
        Effect.provideService(Cvr.CvrStore, cvr),
        Effect.provideService(InvalidationBus.InvalidationBus, bus)
      );

      yield* seedBackend(backend, bus);

      // Client side: durable store (localStorage) + offline transport + engine.
      const transport = makeOfflineTransport(handler, online);
      const store = yield* ClientStore.makeKeyValue({ prefix: "foldkit-todo/" }).pipe(
        Effect.provide(BrowserKeyValueStore.layerLocalStorage)
      );
      const engine = yield* ClientEngine.make({
        clientId: CLIENT_ID,
        clientGroupId: CLIENT_GROUP_ID,
        mutators: clientMutators,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );

      yield* engine.subscribe(allTodos);
      // The sync loop: pull on poke, push + pull on (re)connect. Since the
      // transport reports "connected" immediately, this also flushes any
      // journal left over from a previous offline session and hydrates.
      yield* engine.runSync;

      // Authoritative writes from a "remote" client share the backend; their
      // mutation ids must stay gap-free per client.
      let remoteSeq = 0;

      const world: SyncWorld = {
        observeTodos: () =>
          engine.observe(allTodos).pipe(
            Stream.map((rows) => rows.map((row) => row.value as Todo)),
            Stream.catch(() => Stream.empty)
          ),
        connectionChanges: () => transport.statusChanges,
        pendingNow: () =>
          Effect.runPromise(
            store.pendingMutations.pipe(
              Effect.map((mutations) =>
                mutations.map((mutation) => ({
                  mutationId: mutation.mutationId,
                  summary: summarise(mutation),
                }))
              ),
              Effect.catch(() => Effect.succeed<ReadonlyArray<PendingEntry>>([]))
            )
          ),
        setTodo: (todo) => Effect.runPromise(engine.mutate("todo/set", todo).pipe(Effect.ignore)),
        removeTodo: (id) =>
          Effect.runPromise(engine.mutate("todo/remove", { id }).pipe(Effect.ignore)),
        setOnline: (next) => Effect.runPromise(SubscriptionRef.set(online, next)),
        syncNow: () =>
          Effect.runPromise(engine.push.pipe(Effect.andThen(engine.pull), Effect.ignore)),
        simulateRemote: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              remoteSeq += 1;
              const seq = remoteSeq;
              const todo: Todo = {
                id: `remote-${seq}`,
                title: `Remote agent edit #${seq}`,
                done: false,
                createdAt: Date.now(),
              };
              const result = yield* backend.applyMutations({ clientGroupId: "remote-agent" }, [
                {
                  clientId: "remote-agent",
                  mutationId: seq,
                  mutator: "todo/set",
                  args: Schema.encodeSync(Todo)(todo),
                  createdAt: Date.now(),
                },
              ]);
              // Poke: the sync server fans this out to our subscription, the
              // engine pulls, and the new row appears with no local action.
              yield* bus.publish(result.hints);
            }).pipe(Effect.catch(() => Effect.void))
          ),
      };

      yield* Effect.sync(() => resolve(world));
      // Keep the scope open forever so the forked sync/fan-out fibers live on.
      yield* Effect.never;
    });

    Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.catchCause((cause) => Effect.sync(() => reject(new Error(String(cause)))))
      )
    );
  });

// ─── Module singleton ────────────────────────────────────────────────────────

let current: SyncWorld | undefined;

/** Stash the built world so the FoldKit commands/subscriptions can reach it. */
export const setWorld = (world: SyncWorld): void => {
  current = world;
};

/** The built world; throws if read before {@link createSyncWorld} resolves. */
export const getWorld = (): SyncWorld => {
  if (current === undefined) throw new Error("Sync world not initialised");
  return current;
};
