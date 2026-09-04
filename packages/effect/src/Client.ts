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
 * `subscribe` pins a read's windows — root and, with `include`, edge —
 * beyond any observer. A subscription can also be named by its JSON:API
 * URL (`subscribe(url)`, ADR-0029 section 2) when the Client is built with
 * {@link UrlReads}; the canonical URL is then the subscription's identity
 * for devtools and the façade. Includes resolve through the view's
 * auto-subscribing relational read — host-side on a connected engine,
 * locally on an owned one — with the plan's edge windows applied.
 *
 * **Reads have three tiers and the UI sees none of them** (ADR-0025):
 * `query` answers from the replica when a subscription in this Client's
 * ledger **covers** the read — conjunct subsumption with strict windows
 * (ADR-0029 section 3, `Coverage`); otherwise it falls through to the server — point-in-time,
 * auth-filtered, no CVR, results never entering the replica — degrading
 * back to the local answer when no transport read is available or the
 * server is unreachable (offline-first: local is always an answer).
 * `observe` never falls through: observing subscribes, which IS the
 * upgrade from a one-shot fallthrough to a live, replica-backed read.
 */

import { Context, Effect, Exit, Option, Ref, Scope, Semaphore, Stream } from "effect";
import * as ClientEngine from "./ClientEngine.js";
import * as ClientStore from "./ClientStore.js";
import * as RpcTransport from "./RpcTransport.js";
import * as Transport from "./Transport.js";
import * as ClientView from "./ClientView.js";
import * as Coverage from "./Coverage.js";
import { QueryError } from "./Errors.js";
import type * as Mutator from "./Mutator.js";
import type * as MutationState from "./MutationState.js";
import type * as Node from "./Node.js";
import * as Query from "./Query.js";
import type * as QueryModule from "./Query.js";
import type * as Related from "./Related.js";
import * as Subset from "./Subset.js";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as Mirror from "./Mirror.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

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
  /**
   * Pin a read beyond any observer's lifetime: its root window and, for a
   * read with `include`, its edge windows — the same relational
   * registration `observe` runs (ADR-0029 section 2), so a subscription
   * that covers a read really holds the foreign rows rule 4 promises. A
   * string is a JSON:API URL, parsed and canonicalised through the
   * Client's {@link UrlReads}; `subscribe(url)` and `subscribe(read)` of
   * one query share one ledger entry. Pins are counted: release one per
   * subscribe. Fails with a `QueryError` for a URL the Client cannot
   * parse, or any URL when it was built without `urls`; nothing is
   * registered then.
   */
  readonly subscribe: (
    read: QueryModule.Read | string
  ) => Effect.Effect<void, ClientView.ClientViewError>;
  readonly unsubscribe: (
    read: QueryModule.Read | string
  ) => Effect.Effect<void, ClientView.ClientViewError>;
  /**
   * The canonical URLs of this Client's explicit pins, in registration
   * order — the subscription identities of ADR-0029 section 2, for
   * devtools. A pin whose read has no URL form (a per-edge window) is not
   * listed; a Client built without {@link UrlReads} lists nothing.
   */
  readonly subscriptions: Effect.Effect<ReadonlyArray<string>>;
  /**
   * Which subscription in this Client's ledger covers a read, if any — the
   * check {@link Client.query} makes before answering locally, exposed for
   * devtools (ADR-0029 section 4: "which subscription covered the request
   * is recorded beside it").
   */
  readonly coverageOf: (read: QueryModule.Read) => Effect.Effect<Coverage.Verdict>;
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
   * The keyed mutation-state map (#116) — TanStack Query's
   * `useMutationState` analogue: every journaled mutation's current
   * lifecycle state, current value now then every fold. Works identically
   * over an owned engine and a connected host (ADR-0021).
   */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;
  /**
   * The underlying view — the escape hatch while the ADR-0022 program
   * lands (named-query registration, bindings plumbing).
   */
  readonly view: ClientView.ClientView;
}

/**
 * URL-keyed reads (ADR-0029 section 2): the bridge between a JSON:API URL
 * and a {@link Query.Read}, and the canonical URL that is a subscription's
 * identity. `@legation/effect` does not know the URL grammar — effect-jsonapi
 * owns it, behind `@legation/jsonapi` (ADR-0006) — so a Client takes this
 * as an option: `JsonApiQuery.urlReads(nodes)` from `@legation/jsonapi`
 * builds it from the node graph. A Client built without it fails a URL
 * call with a `QueryError`, never a defect.
 */
export interface UrlReads {
  /** Parse a URL into a read; a `QueryError` names the offending parameter. */
  readonly parse: (url: string) => Effect.Effect<QueryModule.Read, QueryError>;
  /**
   * The canonical URL of a read — one string per plan, whatever spelling
   * the read used. Fails for a read with no URL form (a per-edge window,
   * an `Exists`): such a pin has no URL identity and is not listed by
   * {@link Client.subscriptions}.
   */
  readonly canonical: (read: QueryModule.Read) => Effect.Effect<string, QueryError>;
}

/** Options shared by every way of building a Client. */
export interface ViewOptions {
  /** URL-keyed reads; without them `subscribe(url)` fails with a `QueryError`. */
  readonly urls?: UrlReads;
}

/** One ledger entry: who holds a registration, and what it covers. */
interface Interest extends Coverage.Registration {
  /** Live observers (a live read without `include`). */
  readonly observers: number;
  /** Explicit pins, counted so release is symmetric with subscribe. */
  readonly pins: number;
  /** The canonical URL — the subscription identity — when the read has one. */
  readonly url?: string;
}

/** What a subscribe or unsubscribe resolved its input to. */
interface Target {
  readonly registration: Coverage.Registration;
  readonly url: string | undefined;
}

type Kind = "observer" | "explicit";

/** One more unit of `kind` on a count that tracks `tracked`. */
const oneMore = (count: number | undefined, kind: Kind, tracked: Kind): number =>
  (count ?? 0) + (kind === tracked ? 1 : 0);

/** One unit of `kind` fewer on a count that tracks `tracked`, never below zero. */
const oneFewer = (count: number, kind: Kind, tracked: Kind): number =>
  Math.max(0, count - (kind === tracked ? 1 : 0));

/** Nobody holds the entry any more. */
const unheld = (interest: Interest): boolean => interest.observers === 0 && interest.pins === 0;

/**
 * An entry with one unit of `kind` fewer. The canonical URL is a pin's
 * identity, so it goes with the last pin even while observers keep the
 * entry: {@link Client.coverageOf} names only what {@link Client.subscriptions}
 * lists.
 */
const oneFewerOn = (current: Interest, kind: Kind): Interest => {
  const { url, ...rest } = current;
  const pins = oneFewer(current.pins, kind, "explicit");
  return {
    ...rest,
    observers: oneFewer(current.observers, kind, "observer"),
    pins,
    ...(pins > 0 && url !== undefined ? { url } : {}),
  };
};

/**
 * The ledger key of a registration: the root window's hash alone, or with
 * its edge selects — the same key the mirror protocol gives a relational
 * registration — so a read with `include` is its own entry beside the
 * plain root, and each entry is what coverage compares against.
 */
const keyOf = (registration: Coverage.Registration): string =>
  registration.edges.length === 0
    ? Subset.hash(registration.root)
    : MirrorProtocol.relatedKey(
        registration.root.collection,
        registration.root,
        registration.edges
      );

const noUrlReads = (url: string): QueryError =>
  new QueryError({
    message:
      "Client.subscribe(url): this Client has no URL reads; build it with `urls` " +
      "(`JsonApiQuery.urlReads(nodes)` from @legation/jsonapi) to subscribe by URL",
    query: url,
  });

/**
 * Build a Client over any view. The window ledger lives here, so however
 * many observers a window has — and however the view refcounts — the
 * Client speaks with one voice per window: subscribe on first interest,
 * unsubscribe when the last observer ends and no explicit pin remains.
 */
export const fromView = (
  nodes: Node.NodeRegistry,
  view: ClientView.ClientView,
  options: ViewOptions = {}
): Client => {
  const urls = options.urls;
  // One ledger per Client: registrations keyed by `keyOf`, each holding one
  // unit on its root window, whose view registration is made once however
  // many registrations share it. Edge windows are held per registration in
  // a scope of their own.
  const ledger = Ref.makeUnsafe(new Map<string, Interest>());
  const roots = Ref.makeUnsafe(new Map<string, number>());
  const edgeScopes = new Map<string, Scope.Closeable>();
  // The ledger update and the view registration it decides are one
  // critical section: an unsubscribe interleaved with an in-flight
  // subscribe of the same read would otherwise release before the
  // registration exists, leaking it.
  const lock = Semaphore.makeUnsafe(1);

  // ─── Root windows: one voice per window across every registration ────────

  const holdRoot = (root: Subset.Subset): Effect.Effect<void> =>
    Ref.modify(roots, (map) => {
      const key = Subset.hash(root);
      const count = map.get(key) ?? 0;
      return [count === 0, new Map(map).set(key, count + 1)] as const;
    }).pipe(
      Effect.flatMap((first) => (first ? view.subscribe(root).pipe(Effect.orDie) : Effect.void))
    );

  const dropRoot = (root: Subset.Subset): Effect.Effect<void> =>
    Ref.modify(roots, (map) => {
      const key = Subset.hash(root);
      const count = map.get(key) ?? 0;
      const next = new Map(map);
      if (count <= 1) next.delete(key);
      else next.set(key, count - 1);
      return [count === 1, next] as const;
    }).pipe(
      Effect.flatMap((last) => (last ? view.unsubscribe(root).pipe(Effect.ignore) : Effect.void))
    );

  // ─── Edge windows: the relational registration, held open per entry ──────

  // The registration `observe`'s relational read makes (ADR-0029 section 2)
  // without its join — host-side over a connected engine, the reconcile
  // loop over an owned one — kept open in a scope of its own so the foreign
  // windows keep tracking the linkage until the entry is released.
  const openEdges = (key: string, registration: Coverage.Registration): Effect.Effect<void> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { root, edges } = registration;
      yield* view
        .pinEdges(nodes.collections, root.collection, root, edges)
        .pipe(Scope.provide(scope));
      edgeScopes.set(key, scope);
    });

  const closeEdges = (key: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const scope = edgeScopes.get(key);
      edgeScopes.delete(key);
      return scope === undefined ? Effect.void : Scope.close(scope, Exit.void);
    });

  // ─── The ledger ──────────────────────────────────────────────────────────

  const register = (key: string, registration: Coverage.Registration): Effect.Effect<void> =>
    holdRoot(registration.root).pipe(
      Effect.andThen(registration.edges.length === 0 ? Effect.void : openEdges(key, registration))
    );

  const unregister = (key: string, registration: Coverage.Registration): Effect.Effect<void> =>
    closeEdges(key).pipe(Effect.andThen(dropRoot(registration.root)));

  /** Add one unit of interest; registers with the view when it is the first. */
  const acquire = (
    registration: Coverage.Registration,
    kind: Kind,
    url?: string
  ): Effect.Effect<void> => Semaphore.withPermit(lock, acquireUnlocked(registration, kind, url));

  const acquireUnlocked = (
    registration: Coverage.Registration,
    kind: Kind,
    url: string | undefined
  ): Effect.Effect<void> =>
    Ref.modify(ledger, (map) => {
      const key = keyOf(registration);
      const current = map.get(key);
      const known = url ?? current?.url;
      const next = new Map(map).set(key, {
        ...registration,
        observers: oneMore(current?.observers, kind, "observer"),
        pins: oneMore(current?.pins, kind, "explicit"),
        ...(known === undefined ? {} : { url: known }),
      });
      return [current === undefined ? key : undefined, next] as const;
    }).pipe(
      Effect.flatMap((key) => (key === undefined ? Effect.void : register(key, registration)))
    );

  /** Drop one unit of interest; releases from the view when it was the last. */
  const release = (registration: Coverage.Registration, kind: Kind): Effect.Effect<void> =>
    Semaphore.withPermit(lock, releaseUnlocked(registration, kind));

  const releaseUnlocked = (registration: Coverage.Registration, kind: Kind): Effect.Effect<void> =>
    Ref.modify(ledger, (map) => {
      const key = keyOf(registration);
      const current = map.get(key);
      if (current === undefined) return [undefined, map] as const;
      const updated = oneFewerOn(current, kind);
      const next = new Map(map);
      if (unheld(updated)) {
        next.delete(key);
        return [key, next] as const;
      }
      next.set(key, updated);
      return [undefined, next] as const;
    }).pipe(
      Effect.flatMap((key) => (key === undefined ? Effect.void : unregister(key, registration)))
    );

  // ─── Reads by value or by URL ────────────────────────────────────────────

  const targetOfUrl = (url: string): Effect.Effect<Target, QueryError> =>
    urls === undefined
      ? Effect.fail(noUrlReads(url))
      : Effect.gen(function* () {
          const read = yield* urls.parse(url);
          const plan = yield* Query.tryPlan(nodes, read);
          return { registration: Coverage.ofPlan(plan), url: yield* urls.canonical(read) };
        });

  // A read given by value keeps its URL identity when it has one; a read
  // with no URL form is pinned all the same, without one.
  const targetOfRead = (read: QueryModule.Read): Effect.Effect<Target, QueryError> =>
    Effect.gen(function* () {
      const plan = yield* Query.tryPlan(nodes, read);
      const url =
        urls === undefined
          ? undefined
          : Option.getOrUndefined(yield* Effect.option(urls.canonical(read)));
      return { registration: Coverage.ofPlan(plan), url };
    });

  const targetOf = (input: QueryModule.Read | string): Effect.Effect<Target, QueryError> =>
    typeof input === "string" ? targetOfUrl(input) : targetOfRead(input);

  // ─── Coverage ────────────────────────────────────────────────────────────

  // One rule, one scan: the first ledger entry (in registration order)
  // that covers the read, under `Coverage`. A subset covers itself, so an
  // exact hash hit needs no separate path.
  const verdictOf = (requested: Coverage.Registration): Effect.Effect<Coverage.Verdict> =>
    Ref.get(ledger).pipe(
      Effect.map((interests): Coverage.Verdict => {
        const by = Coverage.covering(interests.values(), requested);
        return by === undefined
          ? { _tag: "Uncovered" }
          : {
              _tag: "Covered",
              by: { root: by.root, edges: by.edges },
              hash: Subset.hash(by.root),
              ...(by.url === undefined ? {} : { url: by.url }),
            };
      })
    );

  // The three-tier read (ADR-0025): replica when a ledger subscription
  // covers the read (ADR-0029); server fallthrough otherwise
  // (`Query.runPlanVia` over the transport's read — the same plan and join
  // the derived REST handlers run server-side — with the plan compiled once,
  // for the coverage verdict and the run); local again when fallthrough is
  // unavailable or fails (offline-first — local is always an answer).
  const queryOnce = (
    read: QueryModule.Read
  ): Effect.Effect<ReadonlyArray<ResolvedRow>, ClientView.ClientViewError> => {
    const local = Query.run(view, nodes, read);
    const readThrough = view.read;
    if (readThrough === undefined) return local;
    const compiled = Query.plan(nodes, read);
    return verdictOf(Coverage.ofPlan(compiled)).pipe(
      Effect.flatMap((verdict) =>
        verdict._tag === "Covered"
          ? local
          : Query.runPlanVia(readThrough, nodes, compiled).pipe(Effect.catch(() => local))
      )
    );
  };

  const observe = (read: QueryModule.Read): Stream.Stream<ReadonlyArray<ResolvedRow>> => {
    const compiled = Query.plan(nodes, read);
    if (compiled.edges.length === 0) {
      const registration = Coverage.ofPlan(compiled);
      return Stream.unwrap(
        Effect.acquireRelease(acquire(registration, "observer"), () =>
          release(registration, "observer")
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
        .related(nodes.collections, read.collection, compiled.root, Query.edgeSelects(compiled))
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
    subscribe: (input) =>
      targetOf(input).pipe(
        Effect.flatMap(({ registration, url }) => acquire(registration, "explicit", url))
      ),
    unsubscribe: (input) =>
      targetOf(input).pipe(Effect.flatMap(({ registration }) => release(registration, "explicit"))),
    subscriptions: Ref.get(ledger).pipe(
      Effect.map((interests) =>
        [...interests.values()].flatMap((entry) =>
          entry.pins > 0 && entry.url !== undefined ? [entry.url] : []
        )
      )
    ),
    coverageOf: (read) => verdictOf(Coverage.ofPlan(Query.plan(nodes, read))),
    mutate: (mutation, args) => view.mutate(mutation, args),
    mutateWithAck: (mutation, args) => view.mutateWithAck(mutation, args),
    mutationStates: view.mutationStates,
    view,
  };
};

/**
 * The Client as a service — for runtimes and bindings that carry "the one
 * per-thread object" in context (ADR-0022).
 */
export const Client = Context.Service<Client>("@legation/effect/Client");

/** Options for a Client that owns its engine ({@link make}). */
export interface MakeOptions extends ViewOptions {
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

/** The view options of a larger option set, absent keys left absent. */
const viewOptions = (options: ViewOptions): ViewOptions =>
  options.urls === undefined ? {} : { urls: options.urls };

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
    return fromView(options.nodes, ClientView.fromEngine(engine), viewOptions(options));
  });

/** Options for a Client connected to an engine hosted elsewhere. */
export interface ConnectOptions extends ViewOptions {
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
    return fromView(options.nodes, mirror, viewOptions(options));
  });
