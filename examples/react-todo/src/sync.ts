/**
 * Sync world
 *
 * The whole sync stack, wired up in the page — the *real* library server
 * pipeline in-process, not a toy request/response:
 *
 *   ClientEngine ──(offline-aware loopback transport)──▶ SyncServer
 *        │                                                   │
 *   durable ClientStore (localStorage)                  MemoryBackend
 *        │                                              + CvrStore (CVR diff)
 *   optimistic overlay + journal                        + InvalidationBus (poke)
 *
 * It exposes two things to the React layer:
 *   - `runtime` — a `ManagedRuntime` providing the built `ClientEngine`, handed
 *     to `<EffectSyncProvider>` so `useQuery` / `useMutation` work;
 *   - `controls` — the demo side-channel (offline toggle, "remote edit", the
 *     durable journal, connection status) that the engine's read/write API
 *     doesn't cover.
 */

import { Effect, Fiber, Layer, ManagedRuntime, Schema, Stream, SubscriptionRef } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  ClientEngine,
  ClientStore,
  Cvr,
  InvalidationBus,
  Introspection,
  MemoryBackend,
  Mutator,
  type Protocol,
  SyncServer,
  Transport,
  TransportError,
} from "@legation/effect";
import type { EffectSyncRuntime } from "@legation/react";

import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  type RemoveArgs,
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

/** Transport connection status, as the UI labels it. */
export type Connection = Transport.ConnectionStatus;

/** The demo side-channel the React UI drives outside `useQuery`/`useMutation`. */
export interface DemoControls {
  /** Flip the transport between online and (failing) offline. */
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Push the journal then pull a patch, right now. */
  readonly syncNow: () => Promise<void>;
  /** Apply an authoritative write as a second client, then poke. */
  readonly simulateRemote: () => Promise<void>;
  /**
   * Subscribe to the pending journal via `EngineIntrospection` (#45): the
   * listener fires now and again on every engine lifecycle event (journal,
   * push, pull, poke, rebuild), so the panel reflects push acks that trim the
   * journal without polling. Returns an unsubscribe.
   */
  readonly subscribeJournal: (
    listener: (entries: ReadonlyArray<PendingEntry>) => void
  ) => () => void;
  /** Subscribe to connection status; returns an unsubscribe. Emits now + on change. */
  readonly subscribeConnection: (listener: (status: Connection) => void) => () => void;
}

/** What `createWorld` resolves to: the engine runtime + the demo controls. */
export interface World {
  readonly runtime: EffectSyncRuntime;
  readonly controls: DemoControls;
}

// ─── Mutator handlers ────────────────────────────────────────────────────────

/**
 * Client handlers write to the optimistic overlay. They run once when the
 * mutation is issued and again on every rebase, so they must be idempotent — a
 * `put` keyed by id is.
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
 * journal; `statusChanges` mirrors the flag so the sync loop flushes on
 * reconnect.
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
      Effect.map((on): Connection => (on ? "connected" : "disconnected"))
    ),
    statusChanges: SubscriptionRef.changes(online).pipe(
      Stream.map((on): Connection => (on ? "connected" : "disconnected"))
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
 * Build the full in-process stack and return a {@link World}. The program runs
 * in a forked, never-closing scope so the engine's sync loop and the server's
 * fan-out loop stay alive for the lifetime of the page.
 */
export const createWorld = (): Promise<World> =>
  new Promise<World>((resolve, reject) => {
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
      const store = yield* ClientStore.makeKeyValue({ prefix: "react-todo/" }).pipe(
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
      // The sync loop: pull on poke, push + pull on (re)connect. Flushes any
      // journal left over from a previous offline session and hydrates.
      yield* engine.runSync;

      // Read-only introspection over the engine + store (#45): the demo journal
      // panel is driven by `journal` + `events`, not by polling the store.
      const introspection = Introspection.make(engine, store);
      const journalEntries: Effect.Effect<ReadonlyArray<PendingEntry>> = introspection.journal.pipe(
        Effect.map((mutations) =>
          mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            summary: summarise(mutation),
          }))
        ),
        Effect.catch(() => Effect.succeed<ReadonlyArray<PendingEntry>>([]))
      );

      // The React bindings drive observe/mutate through a runtime providing the
      // engine we just built; its scope (and the forked sync loop) stays alive
      // because this program ends in `Effect.never`.
      const runtime: EffectSyncRuntime = ManagedRuntime.make(
        Layer.succeed(ClientEngine.ClientEngine, engine)
      );

      // Authoritative writes from a "remote" client share the backend; their
      // mutation ids must stay gap-free per client.
      let remoteSeq = 0;

      const controls: DemoControls = {
        setOnline: (next) => Effect.runPromise(SubscriptionRef.set(online, next)),
        syncNow: () =>
          Effect.runPromise(engine.push.pipe(Effect.andThen(engine.pull), Effect.ignore)),
        subscribeJournal: (listener) => {
          const emit = () => void Effect.runPromise(journalEntries).then(listener);
          // Emit the current journal immediately so first paint is correct.
          emit();
          // Then refresh on every engine lifecycle event (push acks trim it).
          const fiber = Effect.runFork(
            Stream.runForEach(introspection.events, () => Effect.sync(emit))
          );
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        },
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
        subscribeConnection: (listener) => {
          const fiber = Effect.runFork(
            Stream.runForEach(transport.statusChanges, (status) =>
              Effect.sync(() => listener(status))
            )
          );
          // Emit the current status immediately so first paint is correct.
          void Effect.runPromise(transport.status).then(listener);
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        },
      };

      yield* Effect.sync(() => resolve({ runtime, controls }));
      // Keep the scope open forever so the forked sync/fan-out fibers live on.
      yield* Effect.never;
    });

    Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.catchCause((cause) => Effect.sync(() => reject(new Error(String(cause)))))
      )
    );
  });
