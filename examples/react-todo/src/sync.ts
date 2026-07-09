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
 * It exposes three things to the React layer:
 *   - `atoms` — the engine's reactive surface (`EngineAtoms.fromLayer`), handed
 *     to `<EffectSyncProvider>` so `useQuery` / `useMutation` work;
 *   - `devtools` — the `@legation/devtools` headless core (#120) over this
 *     same engine + store, mounted by `<DevtoolsPanel>` — supersedes the
 *     hand-rolled journal panel this example used to read `useMutationState()`
 *     directly for;
 *   - `controls` — the demo side-channel ("remote edit", connection status)
 *     that the engine's read/write API doesn't cover. The offline toggle
 *     itself now lives on the devtools actions panel, wired through the same
 *     `Transport.simulateOffline` decorator devtools' own offline action uses.
 */

import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  ClientStore,
  MemoryBackend,
  Mutator,
  Transport,
} from "@legation/effect";
import { ClientEngine, Cvr, EngineAtoms, InvalidationBus, SyncServer } from "@legation/effect/internal";
import * as Devtools from "@legation/devtools";

import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  type RemoveArgs,
  Todo,
  allTodos,
  removeTodo,
  setTodo,
} from "./domain";

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
  /** Subscribe to connection status; returns an unsubscribe. Emits now + on change. */
  readonly subscribeConnection: (listener: (status: Connection) => void) => () => void;
}

/** What `createWorld` resolves to: the engine's reactive surface, the devtools
 * core (#120), and the demo controls. */
export interface World {
  readonly atoms: EngineAtoms.EngineAtoms;
  readonly devtools: Devtools.DevtoolsCore;
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

// ─── Bootstrap ───────────────────────────────────────────────────────────────

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

      // Client side: durable store (localStorage) + a simulated-offline
      // transport (the devtools' offline-toggle action wraps the same
      // decorator, #120) + engine.
      const base = yield* Transport.makeInMemory(handler, CLIENT_GROUP_ID);
      const { transport, setOffline, isOffline } = yield* Transport.simulateOffline(base);
      const store = yield* ClientStore.makeKeyValue({ prefix: "react-todo/" }).pipe(
        Effect.provide(BrowserKeyValueStore.layerLocalStorage)
      );
      const engine = yield* ClientEngine.make({
        clientId: CLIENT_ID,
        clientGroupId: CLIENT_GROUP_ID,
        mutators: clientMutators,
        // A small terminal-retention bound (#116) so the journal panel visibly
        // demonstrates bounded retention: a handful of recently-settled
        // mutations stay visible, older ones drop off (the journal itself,
        // not this map, is the durable record).
        mutationStateRetention: { maxTerminal: 5 },
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, store),
        Effect.provideService(Transport.ClientTransport, transport)
      );

      yield* engine.subscribe(allTodos);
      // The sync loop: pull on poke, push + pull on (re)connect. Flushes any
      // journal left over from a previous offline session and hydrates.
      yield* engine.runSync;

      // The engine's reactive surface: `useQuery`/`useMutation` read/write
      // through this over `<EffectSyncProvider>`. Its scope (and the forked
      // sync loop) stays alive because this program ends in `Effect.never`.
      const atoms = EngineAtoms.fromLayer(Layer.succeed(ClientEngine.ClientEngine, engine));

      // The devtools headless core (#120), fed by the same engine + store —
      // the offline control is the very same `simulateOffline` toggle the
      // app's own "Go offline" button drives, so either surface reflects the
      // same simulated connectivity.
      const devtools = Devtools.make(engine, store, { offline: { setOffline, isOffline } });

      // Authoritative writes from a "remote" client share the backend; their
      // mutation ids must stay gap-free per client.
      let remoteSeq = 0;

      const controls: DemoControls = {
        setOnline: (next) => Effect.runPromise(setOffline(!next)),
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

      yield* Effect.sync(() => resolve({ atoms, devtools, controls }));
      // Keep the scope open forever so the forked sync/fan-out fibers live on.
      yield* Effect.never;
    });

    Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.catchCause((cause) => Effect.sync(() => reject(new Error(String(cause)))))
      )
    );
  });
