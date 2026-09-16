/**
 * Sync world
 *
 * The whole sync stack, wired up in the page — the *real* library server
 * pipeline in-process, not a toy request/response:
 *
 *   Client ──(offline-aware loopback transport)──▶ Server
 *      │                                             │
 *   durable ClientStore (localStorage)          MemoryBackend
 *      │                                        + CVR diffing
 *   optimistic overlay + journal                + hint fan-out
 *
 * It is assembled as a `Layer` and run by a `ManagedRuntime`: the runtime owns
 * the scope, so the forked sync loop and the server's fan-out live exactly as
 * long as the app does, and nothing has to be kept alive by hand.
 *
 * Two things come out of it:
 *   - `runtime` — provides the `Client` (ADR-0022's one-per-thread object) to
 *     the rune hooks via `setClientRuntime`;
 *   - `demo` — the side-channel the Client's read/write API deliberately
 *     doesn't cover (offline toggle, "remote edit", the durable journal,
 *     connection status), exposed as promises for event handlers.
 */

import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  MemoryBackend,
  Server,
  Transport,
} from "@legation/effect";
// `Undo.make` takes any mutate-capable handle (issue #223), so this app
// builds its `Client` the zero-wiring way, through `Client.make` — no
// hand-built `ClientEngine`, no manual `runSync` fork.
import { type ClientView, type Protocol, Undo } from "@legation/effect/internal";
import type { ClientRuntime } from "@legation/svelte";

import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  type RemoveArgs,
  Todo,
  allTodos,
  mutations,
  nodes,
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

/** The demo side-channel the UI drives outside the Client's own API. */
export interface Demo {
  /** Flip the transport between online and (failing) offline. */
  readonly setOnline: (online: boolean) => Promise<void>;
  /** Apply an authoritative write as a second client, then broadcast. */
  readonly simulateRemote: () => Promise<void>;
  /** Snapshot of the durable journal (pending, unconfirmed mutations). */
  readonly pending: () => Promise<ReadonlyArray<PendingEntry>>;
  /** Connection status: the current value now, then every change. */
  readonly connection: Stream.Stream<Connection>;
}

/** What `createWorld` resolves to. */
export interface World {
  readonly runtime: ClientRuntime;
  readonly demo: Demo;
  /**
   * The per-client undo manager (#46). Its `run`/`undo`/`redo` replay through
   * the same optimistic `mutate` pipeline, so undo is journaled, rebased, and
   * offline-safe like any write; history is in-memory (a page reload clears it).
   * Built from the `Client` (issue #223), so it fails with `ClientViewError`.
   */
  readonly undo: Undo.UndoManager<ClientView.ClientViewError>;
}

// ─── The demo backend ────────────────────────────────────────────────────────

/**
 * Authoritative handlers run inside the backend's transaction; the Client's
 * push delivers the same intents here. `validatedHandlers` schema-checks the
 * pushed args (untrusted input) before applying them.
 */
const backendHandlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(setTodo, (todo, writer) => writer.put("todos", todo.id, todo)),
  MemoryBackend.handler(removeTodo, (args, writer) => writer.del("todos", args.id)),
]);

/** Public collection: read auth is allow-all (this demo has no identities). */
const authPolicy = Authorization.policy(
  { todos: Authorization.allowAll },
  // The node's filterable set bounds what a client may filter or sort by (#154).
  { collections: nodes.collections }
);

/** Seed the backend so a fresh page always has something to sync. */
const seed = (backend: Backend.Backend): Effect.Effect<void> => {
  const now = Date.now();
  const seeds: ReadonlyArray<Todo> = [
    { id: "seed-welcome", title: "Welcome — this list is server state", done: false, createdAt: now },
    { id: "seed-offline", title: "Go offline, add todos: they queue in the journal", done: false, createdAt: now + 1 },
    { id: "seed-live", title: 'Hit "Remote edit" to watch a live pull + rebase', done: true, createdAt: now + 2 },
  ];
  return Effect.forEach(
    seeds,
    (todo, index) =>
      backend.applyMutations({ clientGroupId: "seed" }, [
        {
          clientId: "seed",
          mutationId: index + 1,
          mutator: "todo/set",
          args: Schema.encodeSync(Todo)(todo),
          createdAt: Date.now(),
        },
      ]),
    { discard: true }
  ).pipe(Effect.orDie);
};

// ─── The rig: everything the demo knobs reach for ────────────────────────────

const summarise = (mutation: Protocol.Mutation): string =>
  mutation.mutator === "todo/set"
    ? `set "${(mutation.args as Todo).title}"`
    : `remove ${(mutation.args as RemoveArgs).id}`;

interface Rig {
  readonly client: Client.Client;
  readonly undo: Undo.UndoManager<ClientView.ClientViewError>;
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly connection: Stream.Stream<Connection>;
  readonly pending: Effect.Effect<ReadonlyArray<PendingEntry>>;
  readonly remoteEdit: Effect.Effect<void>;
}
const Rig = Context.Service<Rig>("todo/Rig");

/**
 * Build the server, the transport, and the Client, in one scoped effect.
 * Every fiber forked here (the server's fan-out) is `forkScoped`, so the
 * runtime's scope owns their lifetime; `Client.make` forks its own sync
 * loop the same way.
 */
const rigLayer = Layer.effect(Rig)(
  Effect.gen(function* () {
    // Server side: the one server-side object over the demo backend. CVR
    // storage and the fan-out bus default to in-memory/in-process.
    const backend = yield* MemoryBackend.make(backendHandlers);
    const server = yield* Server.make({ backend, auth: { policy: authPolicy } });
    yield* seed(backend);

    // Client side: durable store (localStorage) + a loopback transport behind
    // a simulated-offline gate. Both are library substrate: `makeInMemory`
    // binds the transport straight to the Server's handler, and
    // `simulateOffline` makes push/pull *fail* while toggled off (as a real
    // network would), so writes pile up in the journal and the sync loop
    // flushes them on reconnect.
    const store = yield* ClientStore.makeKeyValue({ prefix: "todo/" }).pipe(
      Effect.provide(BrowserKeyValueStore.layerLocalStorage)
    );
    const loopback = yield* Transport.makeInMemory(server.handler, CLIENT_GROUP_ID);
    const { transport, setOffline } = yield* Transport.simulateOffline(loopback);

    const client = yield* Client.make({
      nodes,
      mutations,
      clientId: CLIENT_ID,
      clientGroupId: CLIENT_GROUP_ID,
      store,
      transport,
      // Both legs are opt-in: without `pushDebounce` a journaled mutation
      // waits for a reconnect, a poke, or an explicit push, so an online
      // client would sit on "N pending" indefinitely. `pullInterval` is the
      // correctness backstop for when no poke arrives. `Client.make` forks
      // the sync loop itself (pull on poke, push + pull on reconnect),
      // flushing any journal left over from a previous offline session.
      syncLoop: { pushDebounce: "300 millis", pullInterval: "15 seconds" },
    });
    // Pin the list beyond any one observer, so the tab keeps syncing it.
    yield* client.subscribe(allTodos).pipe(Effect.orDie);

    // Authoritative writes from a "remote" client share the backend; their
    // mutation ids must stay gap-free per client.
    let remoteSeq = 0;

    return {
      client,
      undo: yield* Undo.make(client),
      setOffline,
      connection: Stream.concat(Stream.fromEffect(transport.status), transport.statusChanges),
      pending: store.pendingMutations.pipe(
        Effect.map((journal) =>
          journal.map((mutation) => ({
            mutationId: mutation.mutationId,
            summary: summarise(mutation),
          }))
        ),
        Effect.orElseSucceed((): ReadonlyArray<PendingEntry> => [])
      ),
      remoteEdit: Effect.gen(function* () {
        remoteSeq += 1;
        const todo: Todo = {
          id: `remote-${remoteSeq}`,
          title: `Remote agent edit #${remoteSeq}`,
          done: false,
          createdAt: Date.now(),
        };
        yield* backend.applyMutations({ clientGroupId: "remote-agent" }, [
          {
            clientId: "remote-agent",
            mutationId: remoteSeq,
            mutator: "todo/set",
            args: Schema.encodeSync(Todo)(todo),
            createdAt: Date.now(),
          },
        ]);
        // Broadcast: the Server pokes this client's subscription, it pulls,
        // and the new row appears with no local action.
        yield* server.broadcast({ collection: "todos", ids: [todo.id] });
      }).pipe(Effect.ignore),
    };
  })
);

/**
 * The app layer: the rig, plus the `Client` the rune hooks resolve from
 * context. `provideMerge` keeps both services on one build of the rig.
 */
const appLayer = Layer.effect(Client.Client)(Effect.map(Rig, (rig) => rig.client)).pipe(
  Layer.provideMerge(rigLayer)
);

/** Build the world. The `ManagedRuntime` owns the scope for the app's life. */
export const createWorld = async (): Promise<World> => {
  const runtime = ManagedRuntime.make(appLayer);
  const rig = await runtime.runPromise(Rig);
  return {
    runtime,
    undo: rig.undo,
    demo: {
      setOnline: (next) => runtime.runPromise(rig.setOffline(!next)),
      simulateRemote: () => runtime.runPromise(rig.remoteEdit),
      pending: () => runtime.runPromise(rig.pending),
      connection: rig.connection,
    },
  };
};
