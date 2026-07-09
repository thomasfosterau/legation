/**
 * Client
 *
 * The one-per-thread object (ADR-0022): it runs many {@link Query} reads
 * and mutations, and **where a read is answered is configuration, never a
 * concept the UI sees**:
 *
 * - {@link make} owns the engine in this thread (store + transport come
 *   from context; the sync loop starts automatically — the class of bug
 *   where an app forgets `runSync` ends here).
 * - {@link connect} joins an engine hosted elsewhere — a service worker,
 *   an Electron main process, a daemon — over a `MirrorChannel`; the
 *   machinery behind it (the mirror) is internal vocabulary.
 *
 * Reads are declarative ({@link Query.Read}); **observing subscribes**: a
 * live read registers its windows for the stream's lifetime through a
 * per-window ledger (one voice per window, however many observers), and
 * `subscribe` pins a read's root window beyond any observer. Includes
 * resolve through the view's auto-subscribing relational read — host-side
 * on a connected engine, locally on an owned one — with the plan's edge
 * windows applied.
 *
 * **Reads have three tiers and the UI sees none of them** (ADR-0025):
 * `query` answers from the replica when the read's root window is in this
 * Client's ledger; otherwise it falls through to the server — point-in-time,
 * auth-filtered, no CVR, results never entering the replica — degrading
 * back to the local answer when no transport read is available or the
 * server is unreachable (offline-first: local is always an answer).
 * `observe` never falls through: observing subscribes, which IS the
 * upgrade from a one-shot fallthrough to a live, replica-backed read.
 */

import { Context, Effect, Option, Ref, Stream } from "effect";
import * as ClientEngine from "./ClientEngine.js";
import * as ClientStore from "./ClientStore.js";
import * as RpcTransport from "./RpcTransport.js";
import * as Transport from "./Transport.js";
import * as ClientView from "./ClientView.js";
import type * as Mutator from "./Mutator.js";
import type * as Node from "./Node.js";
import * as Query from "./Query.js";
import type * as QueryModule from "./Query.js";
import * as Related from "./Related.js";
import * as Subset from "./Subset.js";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as Mirror from "./Mirror.js";
import type { Scope } from "effect";

/** The rows a read resolves to: node values with their included edges. */
export type ResolvedRow = Related.RelatedRow;

export interface Client {
  /** The node graph this Client reads (bindings compile plans against it). */
  readonly nodes: Node.NodeRegistry;
  /** Run a read once against the local replica (no subscription). */
  readonly query: (
    read: QueryModule.Read
  ) => Effect.Effect<ReadonlyArray<ResolvedRow>, ClientView.ClientViewError>;
  /**
   * Observe a read: current rows now, re-emitting as they change. The
   * read's windows are registered for the stream's lifetime — observing
   * IS subscribing.
   */
  readonly observe: (read: QueryModule.Read) => Stream.Stream<ReadonlyArray<ResolvedRow>>;
  /** Pin a read's root window beyond any observer's lifetime. */
  readonly subscribe: (read: QueryModule.Read) => Effect.Effect<void, ClientView.ClientViewError>;
  readonly unsubscribe: (read: QueryModule.Read) => Effect.Effect<void, ClientView.ClientViewError>;
  /** Journal a mutation and apply it optimistically; resolves on journal. */
  readonly mutate: (
    mutation: string,
    args: unknown
  ) => Effect.Effect<void, ClientView.ClientViewError>;
  /** Like {@link Client.mutate}, resolving with the authoritative outcome. */
  readonly mutateWithAck: (
    mutation: string,
    args: unknown
  ) => Effect.Effect<ClientEngine.MutationOutcome, ClientView.ClientViewError>;
  /**
   * The underlying view — the escape hatch while the ADR-0022 program
   * lands (named-query registration, bindings plumbing).
   */
  readonly view: ClientView.ClientView;
}

/**
 * Build a Client over any view. The window ledger lives here, so however
 * many observers a window has — and however the view refcounts — the
 * Client speaks with one voice per window: subscribe on first interest,
 * unsubscribe when the last observer ends and no explicit pin remains.
 */
export const fromView = (nodes: Node.NodeRegistry, view: ClientView.ClientView): Client => {
  interface Interest {
    readonly observers: number;
    readonly explicit: boolean;
  }
  // One ledger per Client; windows keyed by subset hash.
  const ledger = Ref.makeUnsafe(new Map<string, Interest>());

  const acquire = (subset: Subset.Subset, kind: "observer" | "explicit") =>
    Ref.modify(ledger, (map) => {
      const key = Subset.hash(subset);
      const next = new Map(map);
      const current = next.get(key);
      next.set(key, {
        observers: (current?.observers ?? 0) + (kind === "observer" ? 1 : 0),
        explicit: (current?.explicit ?? false) || kind === "explicit",
      });
      return [current === undefined, next] as const;
    }).pipe(
      Effect.flatMap((first) => (first ? view.subscribe(subset).pipe(Effect.orDie) : Effect.void))
    );

  const release = (subset: Subset.Subset, kind: "observer" | "explicit") =>
    Ref.modify(ledger, (map) => {
      const key = Subset.hash(subset);
      const current = map.get(key);
      if (current === undefined) return [false, map] as const;
      const updated: Interest = {
        observers: Math.max(0, current.observers - (kind === "observer" ? 1 : 0)),
        explicit: kind === "explicit" ? false : current.explicit,
      };
      const next = new Map(map);
      if (updated.observers === 0 && !updated.explicit) {
        next.delete(key);
        return [true, next] as const;
      }
      next.set(key, updated);
      return [false, next] as const;
    }).pipe(
      Effect.flatMap((last) => (last ? view.unsubscribe(subset).pipe(Effect.ignore) : Effect.void))
    );

  const selectsOf = (compiled: Query.Plan): ReadonlyArray<Related.EdgeSelect> =>
    compiled.edges.map((edge) => ({
      name: edge.edge,
      ...(edge.kind === "paginated" && edge.first !== undefined ? { first: edge.first } : {}),
    }));

  // The three-tier read (ADR-0025): replica when the root window is in the
  // ledger; server fallthrough otherwise; local again when fallthrough is
  // unavailable or fails (offline-first — local is always an answer).
  const queryOnce = (
    read: QueryModule.Read
  ): Effect.Effect<ReadonlyArray<ResolvedRow>, ClientView.ClientViewError> => {
    const local = Query.run(view, nodes, read);
    const readThrough = view.read;
    if (readThrough === undefined) return local;
    const compiled = Query.plan(nodes, read);
    return Ref.get(ledger).pipe(
      Effect.flatMap((interests) =>
        interests.has(Subset.hash(compiled.root))
          ? local
          : Related.queryVia(
              readThrough,
              nodes.collections,
              read.collection,
              compiled.root,
              selectsOf(compiled)
            ).pipe(
              Effect.map((rows) => Query.applyWindows(compiled, rows)),
              Effect.catch(() => local)
            )
      )
    );
  };

  const observe = (read: QueryModule.Read): Stream.Stream<ReadonlyArray<ResolvedRow>> => {
    const compiled = Query.plan(nodes, read);
    if (compiled.edges.length === 0) {
      return Stream.unwrap(
        Effect.acquireRelease(acquire(compiled.root, "observer"), () =>
          release(compiled.root, "observer")
        ).pipe(
          Effect.as(
            view.observe(compiled.root).pipe(
              Stream.orDie,
              Stream.map((rows) => rows.map((row) => ({ ...row, related: {} })))
            )
          )
        )
      );
    }
    // The view's relational read auto-subscribes root + narrowed foreign
    // windows itself (host-side on a connected engine), scoped to the stream.
    return Stream.unwrap(
      view
        .related(
          nodes.collections,
          read.collection,
          compiled.root,
          compiled.edges.map((edge) => ({
            name: edge.edge,
            ...(edge.kind === "paginated" && edge.first !== undefined ? { first: edge.first } : {}),
          }))
        )
        .pipe(
          Effect.map((stream) =>
            stream.pipe(Stream.map((rows) => Query.applyWindows(compiled, rows)))
          )
        )
    );
  };

  return {
    nodes,
    query: queryOnce,
    observe,
    subscribe: (read) => acquire(Query.plan(nodes, read).root, "explicit"),
    unsubscribe: (read) => release(Query.plan(nodes, read).root, "explicit"),
    mutate: (mutation, args) => view.mutate(mutation, args),
    mutateWithAck: (mutation, args) => view.mutateWithAck(mutation, args),
    view,
  };
};

/**
 * The Client as a service — for runtimes and bindings that carry "the one
 * per-thread object" in context (ADR-0022).
 */
export const Client = Context.Service<Client>("@legation/effect/Client");

/** Options for a Client that owns its engine ({@link make}). */
export interface MakeOptions {
  readonly nodes: Node.NodeRegistry;
  readonly mutations: Mutator.MutatorRegistry;
  /**
   * The sync-protocol client identity. Defaults to a random id — fine with
   * the default in-memory store; give a stable id alongside a persistent
   * store so the journal survives restarts.
   */
  readonly clientId?: string;
  /**
   * The client group (the server's CVR unit). Defaults to a random id —
   * same caveat as {@link MakeOptions.clientId}.
   */
  readonly clientGroupId?: string;
  /**
   * Row persistence. Resolution order: this option → a `ClientStore` in
   * context (layer-composed apps) → in-memory (the default; pair
   * `@legation/browser`'s IndexedDB store for durability).
   */
  readonly store?: ClientStore.ClientStore;
  /**
   * The server connection. `{ url }` builds the standard remote transport
   * (sync RPCs over WebSocket with HTTP fallback — `RpcTransport.
   * fromOrigin`); a full `ClientTransport` plugs in any carrier.
   * Resolution order: this option → a `ClientTransport` in context →
   * **offline** (no server: reads and optimistic writes work locally, the
   * journal retains every intent, and the sync loop is not started).
   */
  readonly transport?: Transport.ClientTransport | { readonly url: string };
  readonly queries?: QueryModule.QueryRegistry;
  readonly syncLoop?: ClientEngine.SyncLoopOptions;
  /**
   * Auto-discover indexable fields from registered subsets and index them
   * (issue #113), in addition to any `indexes` a Node/Collection declares.
   * Defaults to `false`: zero-config behaviour is identical to no indexing.
   */
  readonly autoIndex?: boolean;
  /**
   * Start the sync loop automatically. Defaults to `true` with a
   * transport, `false` when the Client defaulted to offline.
   */
  readonly sync?: boolean;
}

/** The `indexes` declared on each of `nodes`' collections, by collection name. */
const declaredIndexes = (
  nodes: Node.NodeRegistry
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const indexes: Record<string, ReadonlyArray<string>> = {};
  for (const [name, collection] of nodes.collections) {
    if (collection.indexes !== undefined && collection.indexes.length > 0) {
      indexes[name] = collection.indexes;
    }
  }
  return indexes;
};

/**
 * A Client that owns the engine in this thread. Zero wiring works:
 * `Client.make({ nodes, mutations })` is a purely local Client over an
 * in-memory store. Add `transport: { url }` for the standard remote setup,
 * or pass/provide full `ClientStore`/`ClientTransport` implementations for
 * anything else — options win over context, context over defaults.
 */
export const make = (options: MakeOptions): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.gen(function* () {
    const store =
      options.store ??
      Option.getOrUndefined(yield* Effect.serviceOption(ClientStore.ClientStore)) ??
      (yield* ClientStore.makeMemory);

    const clientGroupId = options.clientGroupId ?? `group-${crypto.randomUUID()}`;
    const configured =
      options.transport !== undefined && "url" in options.transport
        ? yield* RpcTransport.fromOrigin({ origin: options.transport.url, clientGroupId })
        : options.transport;
    const contextual = Option.getOrUndefined(
      yield* Effect.serviceOption(Transport.ClientTransport)
    );
    const transport = configured ?? contextual ?? Transport.offline;
    // Defaulted offline: nothing to sync with, so the loop stays off
    // unless the caller insists.
    const sync = options.sync ?? (configured ?? contextual) !== undefined;

    const indexes = declaredIndexes(options.nodes);
    const engine = yield* ClientEngine.make({
      clientId: options.clientId ?? `client-${crypto.randomUUID()}`,
      clientGroupId,
      mutators: options.mutations,
      ...(options.queries === undefined ? {} : { queries: options.queries }),
      ...(options.syncLoop === undefined ? {} : { syncLoop: options.syncLoop }),
      ...(Object.keys(indexes).length > 0 ? { indexes } : {}),
      ...(options.autoIndex === undefined ? {} : { autoIndex: options.autoIndex }),
    }).pipe(
      Effect.provideService(ClientStore.ClientStore, store),
      Effect.provideService(Transport.ClientTransport, transport)
    );
    if (sync) yield* Effect.forkScoped(engine.runSync.pipe(Effect.orDie));
    return fromView(options.nodes, ClientView.fromEngine(engine));
  });

/** Options for a Client connected to an engine hosted elsewhere. */
export interface ConnectOptions {
  readonly nodes: Node.NodeRegistry;
  readonly mutations: Mutator.MutatorRegistry;
  readonly channel: MirrorChannel;
}

/**
 * A Client over an engine hosted elsewhere (service worker, Electron main,
 * a daemon), joined over a `MirrorChannel`. Reads and writes cross the
 * channel; relational reads resolve host-side.
 */
export const connect = (options: ConnectOptions): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mirror = yield* Mirror.make({ channel: options.channel, mutators: options.mutations });
    return fromView(options.nodes, mirror);
  });
