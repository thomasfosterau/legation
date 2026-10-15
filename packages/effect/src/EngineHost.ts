/**
 * EngineHost
 *
 * The host side of the mirror protocol (ADR-0010): serves a running
 * ClientEngine to mirrors over a MirrorChannel — one per client context (a
 * browser tab, an Electron window, an extension, a CLI instance). Mutations
 * forward into
 * the engine's journal (optimism included — the engine's change event
 * re-broadcasts materialized rows to every mirror); subset subscriptions,
 * named-query registrations, and `related` registrations are made with the
 * engine and their live results broadcast on every change.
 *
 * For `related`, the host owns the whole relational read: the reconcile
 * loop that tracks the narrowed foreign subsets AND the join itself run
 * here, and mirrors receive resolved rows — data work stays out of the UI
 * context (ADR-0010's goal), which is why a mirror does not need the
 * collection registry.
 *
 * Registrations are refcounted by mirror: an engine registration and its
 * broadcast fiber start when the first mirror subscribes and stop only when
 * the last mirror unsubscribes or disconnects. `Disconnect` releases
 * everything a departing mirror held — the close-time signal for an orderly
 * exit.
 *
 * A mirror that crashes can't send `Disconnect`, so the host also tracks
 * each mirror's last-seen time (refreshed by subscribes and heartbeats) and a
 * sweep fiber reclaims registrations from mirrors silent past
 * `mirrorTimeout`. This is
 * the disconnect detection a BroadcastChannel can't provide on its own.
 *
 * Engine subscriptions are made through one counted voice
 * (`Subscriptions.counted`): a subset registration and a `related`
 * registration of the same root window — or two `related` registrations
 * pinning one foreign window — release independently, and the engine drops
 * the window only when the last registration lets go.
 *
 * A party with no `Client` at all — a page whose only JavaScript is a
 * `postMessage` — registers by URL (`SubscribeUrl`, ADR-0029 section 2,
 * #159): given `nodes` and `urls`, the host parses the URL, plans the read
 * and registers its root and edge windows under the party's `mirrorId`,
 * exactly as `Subscribe` and `SubscribeRelated` would.
 *
 * The host is the only party in a worker that knows what the mirrors hold,
 * so {@link run} hands back a {@link Host} listing its registrations —
 * every root window and relational registration it made with the engine,
 * with the canonical URL of a `SubscribeUrl` while a party still holds it
 * by URL — as the ledger a façade's coverage check scans
 * (`Coverage.coverageOf`, ADR-0029 section 3). A registration is listed
 * once its engine registration has been made — the root subscribed, or the
 * relational read's root and edge windows registered — and dropped when
 * its last mirror releases it or is swept, so a read judged covered is one
 * whose rows the engine syncs. A relational registration naming an edge
 * the registry does not declare registers nothing: the engine would never
 * sync that edge, so nothing may be credited for it.
 */

import type { UrlReads } from "./Client.js";
import * as ClientEngine from "./ClientEngine.js";
import * as Collection from "./Collection.js";
import * as Coverage from "./Coverage.js";
import { QueryError, TransportError } from "./Errors.js";
import type * as MutationState from "./MutationState.js";
import type * as Node from "./Node.js";
import * as PullMarks from "./PullMarks.js";
import * as Query from "./Query.js";
import * as Related from "./Related.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Subset from "./Subset.js";
import { Clock, Duration, Effect, Exit, Fiber, HashMap, Option, Ref, Scope, Stream } from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

/** Options for {@link run}: the channel mirrors connect over and the engine they share. */
export interface EngineHostOptions {
  readonly channel: MirrorChannel;
  readonly engine: ClientEngine.ClientEngine;
  /**
   * The collection registry `related` registrations resolve against.
   * Defaults to `nodes.collections` when `nodes` is given; without either,
   * `SubscribeRelated` messages are answered with empty results and a
   * logged warning — pass one whenever mirrors use relational reads.
   */
  readonly registry?: Collection.CollectionRegistry;
  /**
   * The node graph and URL-keyed reads `SubscribeUrl` registrations are
   * parsed and planned against (#159). Without both, a `SubscribeUrl` is
   * answered with a logged warning and registers nothing.
   */
  readonly nodes?: Node.NodeRegistry;
  readonly urls?: UrlReads;
  /**
   * Liveness sweep: reclaim registrations from mirrors not heard from within
   * `mirrorTimeout`, checked every `sweepInterval`. Defaults: 30s timeout,
   * 10s sweep — pair with a Mirror heartbeat shorter than the timeout.
   */
  readonly liveness?: {
    readonly mirrorTimeout?: Duration.Input;
    readonly sweepInterval?: Duration.Input;
  };
}

/** The running host: what a worker can consult about the mirrors it serves. */
export interface Host {
  /**
   * The registrations the host holds on mirrors' behalf at this moment, each
   * with its pulled summary (#426): root windows (`Subscribe`), relational
   * registrations with their edge selects (`SubscribeRelated`) and both
   * halves of a `SubscribeUrl`, the latter carrying its canonical URL for as
   * long as some party holds it by that URL. A registration's windows are
   * pulled once a pull started after each was made has applied; a coverage
   * check counts only the windows a read depends on. Named-query and
   * mutation-state registrations cover no read and are not listed. The ledger
   * a coverage check scans: `Coverage.coverageOf(nodes, view.query, host.registrations)`.
   */
  readonly registrations: Effect.Effect<ReadonlyArray<Coverage.Entry>>;
}

/** What a read's registration covers, and the URL identity a `SubscribeUrl` gave it. */
interface Registered {
  readonly registration: Coverage.Registration;
  readonly url?: string;
}

/** One actively-broadcast registration: which mirrors hold it, its fiber, teardown. */
interface Active {
  readonly mirrors: ReadonlySet<string>;
  /** The mirrors holding this registration by URL (`SubscribeUrl`); the URL is reported while any remains. */
  readonly urlMirrors: ReadonlySet<string>;
  readonly fiber: Fiber.Fiber<void, never>;
  /** Engine-side release beyond interrupting the fiber (e.g. unsubscribe). */
  readonly teardown: Effect.Effect<void>;
  /** Re-hydrate a newly-joining mirror from the current result. */
  readonly hydrate: Effect.Effect<void>;
  /** What the registration covers, when it is a read's (not a named query's or the mutation states'). */
  readonly registered?: Registered;
}

/** Whether a registration's edges are all declared by the registry; the first that is not, otherwise. */
const undeclaredEdge = (
  registry: Collection.CollectionRegistry,
  collection: string,
  edges: ReadonlyArray<Related.EdgeSelect>
): Related.EdgeSelect | undefined => {
  const declared = Collection.relationshipsOf(registry, collection);
  return edges.find((edge) => !declared.has(edge.name));
};

/** The subscription an entry reports: its registration, with the URL while a party holds it by URL. */
const subscriptionOf = (entry: Active): Coverage.Subscription | undefined =>
  entry.registered === undefined
    ? undefined
    : {
        ...entry.registered.registration,
        ...(entry.urlMirrors.size > 0 && entry.registered.url !== undefined
          ? { url: entry.registered.url }
          : {}),
      };

/** A set with one member fewer. */
const without = (set: ReadonlySet<string>, member: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(member);
  return next;
};

/** Liveness settings with their defaults applied. */
const livenessOf = (options: EngineHostOptions) => ({
  mirrorTimeout: options.liveness?.mirrorTimeout ?? "30 seconds",
  sweepInterval: options.liveness?.sweepInterval ?? "10 seconds",
});

/**
 * Serve the engine over the channel. The inbound subscription is
 * established before this effect completes; message handling runs on a
 * scoped background fiber.
 */
export const run = (options: EngineHostOptions): Effect.Effect<Host, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { channel } = options;
    const engine = Subscriptions.counted(options.engine);
    const inbox = yield* channel.subscribe;
    const active = yield* Ref.make(new Map<string, Active>());
    const lastSeen = yield* Ref.make(new Map<string, number>());
    // Each registration's pull mark (#426): pulled once a pull started after it has applied.
    const marks = PullMarks.make(engine);
    // The pulled summaries last sent to mirrors, so `PulledRegistrations` goes out only when they change.
    const announced = yield* Ref.make<string | undefined>(undefined);
    const announce = Effect.gen(function* () {
      const registrations = yield* marks.registrations;
      const serialised = JSON.stringify(registrations);
      if (serialised === (yield* Ref.get(announced))) return;
      yield* Ref.set(announced, serialised);
      yield* channel.post({ _tag: "PulledRegistrations", registrations }).pipe(Effect.ignore);
    });

    // Pulls that sync new registrations, at most one fibre at a time (#426). A
    // registration made while one runs sets `again`, and the running fibre pulls
    // once more after it ends, so the pull that makes the registration pulled
    // starts after it. A burst of subscribes therefore costs one extra pull, not
    // one fibre per subscribe.
    const syncState = yield* Ref.make<"idle" | "running" | "again">("idle");
    const syncUntilSettled: Effect.Effect<void, never, Scope.Scope> = engine.pull.pipe(
      Effect.ignore,
      Effect.andThen(
        Ref.modify(syncState, (state) =>
          state === "again" ? ([true, "running"] as const) : ([false, "idle"] as const)
        )
      ),
      Effect.flatMap((again) => (again ? syncUntilSettled : Effect.void))
    );
    const syncRegistrations: Effect.Effect<void, never, Scope.Scope> = Ref.modify(
      syncState,
      (state) => (state === "idle" ? ([true, "running"] as const) : ([false, "again"] as const))
    ).pipe(
      Effect.flatMap((started) => (started ? Effect.forkScoped(syncUntilSettled) : Effect.void)),
      Effect.asVoid
    );

    const touch = (mirrorId: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.update(lastSeen, (map) => new Map(map).set(mirrorId, now)))
      );
    const forget = (mirrorId: string) =>
      Ref.update(lastSeen, (map) => {
        const next = new Map(map);
        next.delete(mirrorId);
        return next;
      });

    const broadcast = (key: string, rows: ReadonlyArray<ClientEngine.LocalRow>) =>
      channel.post(MirrorProtocol.mirrorUpdate(key, rows));
    const broadcastRelated = (key: string, rows: ReadonlyArray<Related.RelatedRow>) =>
      channel.post(MirrorProtocol.relatedUpdate(key, rows));
    const broadcastMutationStates = (states: MutationState.MutationStateMap) =>
      channel.post(MirrorProtocol.mutationStatesUpdate(states));
    // A one-shot snapshot of the engine's mutation-state map: `mutationStates`
    // is built over `SubscriptionRef.changes`, which replays the current value
    // to a fresh subscriber, so its first emission IS the current snapshot.
    const currentMutationStates: Effect.Effect<MutationState.MutationStateMap> = Stream.runHead(
      engine.mutationStates
    ).pipe(Effect.map(Option.getOrElse(() => HashMap.empty())));

    /**
     * Register (or refcount) one broadcastable registration. `start` begins
     * the engine registration and returns the broadcast loop to fork; a mirror
     * joining an already-active key is hydrated from the current result. What
     * a read's registration covers is recorded only once `start` has
     * succeeded — the engine holds the windows — and its URL identity while
     * some mirror holds the key by URL.
     */
    const acquire = (
      mirrorId: string,
      key: string,
      start: Effect.Effect<
        {
          readonly loop: Effect.Effect<void, unknown>;
          readonly teardown: Effect.Effect<void>;
          readonly hydrate: Effect.Effect<void>;
        },
        unknown,
        Scope.Scope
      >,
      registered?: Registered
    ): Effect.Effect<void, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const byUrl = registered?.url !== undefined;
        const existing = (yield* Ref.get(active)).get(key);
        if (existing !== undefined) {
          // A URL identity learnt later (a `SubscribeUrl` joining a plain
          // `Subscribe` of the same window) is kept on the entry.
          const known = existing.registered?.url === undefined ? registered : existing.registered;
          yield* Ref.update(active, (map) =>
            new Map(map).set(key, {
              ...existing,
              mirrors: new Set(existing.mirrors).add(mirrorId),
              urlMirrors: byUrl ? new Set(existing.urlMirrors).add(mirrorId) : existing.urlMirrors,
              ...(known === undefined ? {} : { registered: known }),
            })
          );
          return yield* existing.hydrate;
        }
        // A failed start (an unknown named query, an undeclared edge) registers
        // nothing and records nothing; the message loop swallows the error and
        // the mirror simply never hydrates.
        const { loop, teardown, hydrate } = yield* start;
        const fiber = yield* Effect.forkScoped(loop.pipe(Effect.ignore));
        yield* Ref.update(active, (map) =>
          new Map(map).set(key, {
            mirrors: new Set([mirrorId]),
            urlMirrors: new Set(byUrl ? [mirrorId] : []),
            fiber,
            teardown,
            hydrate,
            ...(registered === undefined ? {} : { registered }),
          })
        );
        yield* announce;
      });

    /** Drop one mirror from one registration; tear it down if it was the last. */
    const release = (mirrorId: string, key: string) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(active)).get(key);
        if (entry === undefined || !entry.mirrors.has(mirrorId)) return;
        const mirrors = without(entry.mirrors, mirrorId);
        if (mirrors.size > 0) {
          yield* Ref.update(active, (map) =>
            new Map(map).set(key, {
              ...entry,
              mirrors,
              urlMirrors: without(entry.urlMirrors, mirrorId),
            })
          );
          return;
        }
        yield* Fiber.interrupt(entry.fiber);
        yield* entry.teardown.pipe(Effect.ignore);
        yield* Ref.update(active, (map) => {
          const next = new Map(map);
          next.delete(key);
          return next;
        });
        yield* announce;
      });

    const handleSubscribe = (mirrorId: string, subset: Subset.Subset, url?: string) => {
      const key = Subset.hash(subset);
      return acquire(
        mirrorId,
        key,
        Effect.gen(function* () {
          yield* marks.open(key, subset);
          yield* marks
            .wrap(key)
            .subscribe(subset)
            .pipe(Effect.tapError(() => marks.close(key)));
          // Sync the registration promptly, as a named query's is (#426): the rows
          // a covered read needs arrive on a pull that starts after this one. Forked,
          // so the message loop does not wait on the network.
          yield* syncRegistrations;
          return {
            // `observe` emits the current rows first, hydrating the subscriber.
            loop: Stream.runForEach(engine.observe(subset), (rows) => broadcast(key, rows)).pipe(
              Effect.asVoid
            ),
            teardown: marks
              .wrap(key)
              .unsubscribe(subset)
              .pipe(Effect.ignore, Effect.andThen(marks.close(key))),
            hydrate: engine.query(subset).pipe(
              Effect.flatMap((rows) => broadcast(key, rows)),
              Effect.ignore
            ),
          };
        }),
        { registration: { root: subset, edges: [] }, ...(url === undefined ? {} : { url }) }
      );
    };

    const handleSubscribeNamed = (mirrorId: string, name: string, args: unknown) => {
      const key = MirrorProtocol.namedKey(name, args);
      return acquire(
        mirrorId,
        key,
        Effect.gen(function* () {
          yield* engine.subscribeQuery(name, args);
          // Sync the registration promptly; a failed pull only delays rows
          // (the engine's own sync loop recovers).
          yield* engine.pull.pipe(Effect.ignore);
          return {
            loop: Stream.runForEach(engine.observeNamed(name, args), (rows) =>
              broadcast(key, rows)
            ).pipe(Effect.asVoid),
            teardown: engine.unsubscribeQuery(name, args).pipe(Effect.ignore),
            hydrate: engine.queryNamed(name, args).pipe(
              Effect.flatMap((rows) => broadcast(key, rows)),
              Effect.ignore
            ),
          };
        })
      );
    };

    const handleSubscribeRelated = (
      mirrorId: string,
      collection: string,
      subset: Subset.Subset,
      edges: ReadonlyArray<Related.EdgeSelect>,
      url?: string
    ) => {
      const key = MirrorProtocol.relatedKey(collection, subset, edges);
      const registry = options.registry ?? options.nodes?.collections;
      if (registry === undefined) {
        return Effect.logWarning(
          "EngineHost: SubscribeRelated received but no collection registry was configured"
        ).pipe(Effect.andThen(broadcastRelated(key, [])), Effect.ignore);
      }
      return acquire(
        mirrorId,
        key,
        Effect.gen(function* () {
          // `Related` selects the edges it knows and ignores the rest, so an
          // undeclared edge must be refused here: nothing registers, nothing
          // is credited for it.
          const undeclared = undeclaredEdge(registry, collection, edges);
          if (undeclared !== undefined) {
            return yield* Effect.fail(
              new QueryError({
                message: `EngineHost: SubscribeRelated on "${collection}" names an edge the registry does not declare: "${undeclared.name}"`,
                query: collection,
              })
            );
          }
          // The relational read is established here — its root subscribed,
          // its edge windows registered by the reconcile loop — in a scope of
          // its own under the host's, closed by the teardown; the broadcast
          // loop merely drains its stream.
          const scope = yield* Scope.fork(yield* Effect.scope);
          yield* marks.open(key, subset);
          const stream = yield* Related.related(
            marks.wrap(key),
            registry,
            collection,
            subset,
            edges
          ).pipe(
            Scope.provide(scope),
            Effect.tapError(() => marks.close(key))
          );
          return {
            loop: Stream.runForEach(stream, (rows) => broadcastRelated(key, rows)),
            teardown: Scope.close(scope, Exit.void).pipe(Effect.andThen(marks.close(key))),
            hydrate: Related.query(engine, registry, collection, subset, edges).pipe(
              Effect.flatMap((rows) => broadcastRelated(key, rows)),
              Effect.ignore
            ),
          };
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(`EngineHost: SubscribeRelated rejected: ${String(error)}`)
          )
        ),
        { registration: { root: subset, edges }, ...(url === undefined ? {} : { url }) }
      );
    };

    // The mutation-state map (#116): a singleton registration (unlike
    // subsets/named queries, there is exactly one per engine), so it acquires
    // under the fixed `MUTATION_STATES_KEY` — refcounted across mirrors the
    // same way a subset subscription is.
    const handleSubscribeMutationStates = (mirrorId: string) =>
      acquire(
        mirrorId,
        MirrorProtocol.MUTATION_STATES_KEY,
        Effect.succeed({
          // `mutationStates` emits the current map first, hydrating the
          // subscriber, then again on every fold.
          loop: Stream.runForEach(engine.mutationStates, broadcastMutationStates).pipe(
            Effect.asVoid
          ),
          teardown: Effect.void,
          hydrate: currentMutationStates.pipe(
            Effect.flatMap(broadcastMutationStates),
            Effect.ignore
          ),
        })
      );

    // A URL-keyed registration (#159) from a party without a Client: parsed
    // and planned here, then registered as the party's Subscribe (root) and
    // SubscribeRelated (edge windows) would be — same refcount per mirrorId,
    // same liveness sweep. A URL the host cannot parse registers nothing.
    const { nodes, urls } = options;
    const registrationOfUrl = (url: string): Effect.Effect<Coverage.Subscription, QueryError> =>
      urls === undefined || nodes === undefined
        ? Effect.fail(
            new QueryError({
              message: "EngineHost: SubscribeUrl received but no `nodes`/`urls` were configured",
              query: url,
            })
          )
        : Effect.gen(function* () {
            const read = yield* urls.parse(url);
            const plan = yield* Query.tryPlan(nodes, read);
            // The canonical URL is the registration's identity (ADR-0029
            // section 2); a URL the parser accepted always has one.
            return { ...Coverage.ofPlan(plan), url: yield* urls.canonical(read) };
          });

    // The URL names the whole registration: the relational entry when the
    // URL includes edges, the root entry otherwise.
    const handleSubscribeUrl = (mirrorId: string, url: string) =>
      registrationOfUrl(url).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`EngineHost: SubscribeUrl "${url}" rejected: ${error.message}`)
        ),
        Effect.flatMap(({ root, edges, url: canonical }) =>
          edges.length === 0
            ? handleSubscribe(mirrorId, root, canonical)
            : handleSubscribe(mirrorId, root).pipe(
                Effect.andThen(
                  handleSubscribeRelated(mirrorId, root.collection, root, edges, canonical)
                )
              )
        )
      );

    const handleUnsubscribeUrl = (mirrorId: string, url: string) =>
      registrationOfUrl(url).pipe(
        Effect.flatMap(({ root, edges }) =>
          release(mirrorId, Subset.hash(root)).pipe(
            Effect.andThen(
              edges.length === 0
                ? Effect.void
                : release(mirrorId, MirrorProtocol.relatedKey(root.collection, root, edges))
            )
          )
        ),
        Effect.ignore
      );

    // The server-fallthrough read (ADR-0025): the host owns the transport, so
    // it performs the read and answers point-in-time. Nothing is registered
    // and nothing enters the store — errors travel back as the result.
    const handleRead = (requestId: number, subsets: ReadonlyArray<Subset.Subset>) =>
      (engine.readThrough === undefined
        ? Effect.fail(new TransportError({ message: "Host transport does not support reads" }))
        : engine.readThrough(subsets)
      ).pipe(
        Effect.flatMap((rows) =>
          channel.post({
            _tag: "ReadResult",
            requestId,
            rows: rows.map((row) => ({
              collection: row.collection,
              id: row.id,
              value: row.value,
            })),
          })
        ),
        Effect.catch((error) =>
          channel.post({ _tag: "ReadResult", requestId, rows: [], error: error.message })
        )
      );

    const handleDisconnect = (mirrorId: string) =>
      Effect.gen(function* () {
        const keys = [...(yield* Ref.get(active))]
          .filter(([, entry]) => entry.mirrors.has(mirrorId))
          .map(([key]) => key);
        for (const key of keys) yield* release(mirrorId, key);
        yield* forget(mirrorId);
      });

    // The backend's authoritative outcome for a forwarded mutation, posted back
    // to the mirror so `Mirror.mutateWithAck` can resolve. Runs on a scoped
    // fibre because `acknowledged` only settles on a later push/pull.
    const postSettled = (requestId: number, outcome: ClientEngine.MutationOutcome) =>
      channel.post({
        _tag: "MutateSettled",
        requestId,
        outcome: outcome._tag,
        ...(outcome._tag === "rejected" ? { reason: outcome.reason } : {}),
      });

    const handleMutate = (message: MirrorProtocol.MirrorMessage & { readonly _tag: "Mutate" }) =>
      engine.mutateWithAck(message.mutator, message.args).pipe(
        Effect.flatMap((mutation) =>
          // Ack on journal (unchanged mirror behaviour), then await the backend
          // outcome on a background fibre and forward it.
          channel
            .post({ _tag: "MutateAck", requestId: message.requestId })
            .pipe(
              Effect.andThen(
                Effect.forkScoped(
                  mutation.acknowledged.pipe(
                    Effect.flatMap((outcome) => postSettled(message.requestId, outcome))
                  )
                )
              )
            )
        ),
        Effect.catch((error) =>
          channel.post({
            _tag: "MutateError",
            requestId: message.requestId,
            message: error.message,
          })
        )
      );

    const handle = (message: MirrorProtocol.MirrorMessage) => {
      switch (message._tag) {
        case "Mutate":
          return handleMutate(message);
        case "Subscribe":
          return touch(message.mirrorId).pipe(
            Effect.andThen(handleSubscribe(message.mirrorId, message.subset))
          );
        case "Unsubscribe":
          return touch(message.mirrorId).pipe(
            Effect.andThen(release(message.mirrorId, Subset.hash(message.subset)))
          );
        case "SubscribeNamed":
          return touch(message.mirrorId).pipe(
            Effect.andThen(handleSubscribeNamed(message.mirrorId, message.name, message.args))
          );
        case "UnsubscribeNamed":
          return touch(message.mirrorId).pipe(
            Effect.andThen(
              release(message.mirrorId, MirrorProtocol.namedKey(message.name, message.args))
            )
          );
        case "SubscribeRelated":
          return touch(message.mirrorId).pipe(
            Effect.andThen(
              handleSubscribeRelated(
                message.mirrorId,
                message.collection,
                message.subset,
                message.edges
              )
            )
          );
        case "UnsubscribeRelated":
          return touch(message.mirrorId).pipe(
            Effect.andThen(
              release(
                message.mirrorId,
                MirrorProtocol.relatedKey(message.collection, message.subset, message.edges)
              )
            )
          );
        case "SubscribeUrl":
          return touch(message.mirrorId).pipe(
            Effect.andThen(handleSubscribeUrl(message.mirrorId, message.url))
          );
        case "UnsubscribeUrl":
          return touch(message.mirrorId).pipe(
            Effect.andThen(handleUnsubscribeUrl(message.mirrorId, message.url))
          );
        case "Read":
          return handleRead(message.requestId, message.subsets);
        case "SubscribeMutationStates":
          return touch(message.mirrorId).pipe(
            Effect.andThen(handleSubscribeMutationStates(message.mirrorId))
          );
        case "UnsubscribeMutationStates":
          return touch(message.mirrorId).pipe(
            Effect.andThen(release(message.mirrorId, MirrorProtocol.MUTATION_STATES_KEY))
          );
        case "Disconnect":
          return handleDisconnect(message.mirrorId);
        case "Heartbeat":
          return touch(message.mirrorId);
      }
    };

    // Liveness sweep: reclaim registrations from mirrors silent past the timeout.
    const { mirrorTimeout, sweepInterval } = livenessOf(options);
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - Duration.toMillis(mirrorTimeout);
      const stale = [...(yield* Ref.get(lastSeen))]
        .filter(([, seen]) => seen < cutoff)
        .map(([mirrorId]) => mirrorId);
      for (const mirrorId of stale) yield* handleDisconnect(mirrorId);
    });
    yield* Effect.forkScoped(
      Effect.forever(sweep.pipe(Effect.andThen(Effect.sleep(sweepInterval))))
    );

    // A pull that applies may make a registration pulled: tell the mirrors. The
    // stream is opened here, before anything is forked: `engineEvents` subscribes
    // when it is first pulled, so a `PullCompleted` published before a forked
    // reader ran would be missed (#426).
    const pullEvents = yield* Stream.toPull(engine.engineEvents);
    yield* Effect.forkScoped(
      Effect.forever(
        pullEvents.pipe(
          Effect.flatMap((events) =>
            Effect.forEach(
              events,
              (event) => (event._tag === "PullCompleted" ? announce : Effect.void),
              { discard: true }
            )
          )
        )
      ).pipe(Effect.ignore)
    );

    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeMirrorMessage),
          Effect.flatMap((message) =>
            message === undefined ? Effect.void : handle(message).pipe(Effect.ignore)
          )
        )
      )
    );

    // The pulled set first (empty at boot), then readiness LAST: mirrors that
    // raced this host's boot (or survived a previous host) answer by re-posting
    // their registrations.
    yield* announce;
    yield* channel.post({ _tag: "HostReady" }).pipe(Effect.ignore);

    return {
      registrations: Effect.all({ entries: Ref.get(active), pulled: marks.registrations }).pipe(
        Effect.map(({ entries, pulled }) => {
          const summaries = new Map(pulled.map((entry) => [entry.key, entry.pulled]));
          return [...entries].flatMap(([key, entry]) => {
            const subscription = subscriptionOf(entry);
            return subscription === undefined
              ? []
              : [{ ...subscription, pulled: summaries.get(key) ?? Coverage.NOT_PULLED }];
          });
        })
      ),
    };
  });
