/**
 * Mirror
 *
 * The consumer side of ADR-0010: an in-memory copy of subscribed subsets
 * held by a client context — a browser tab, an Electron window, an
 * extension, a CLI instance —
 * hydrated and kept current by engine-host broadcasts, with queries served
 * synchronously from the mirror. Mutations validate locally against the
 * shared mutator registry (fail fast in the mirror), then forward to the host
 * journal in encoded form and await the host's acknowledgement.
 */

import type * as ClientEngine from "./ClientEngine.js";
import type * as ClientView from "./ClientView.js";
import type * as Collection from "./Collection.js";
import * as Coverage from "./Coverage.js";
import { MutatorError, StoreError, TransportError } from "./Errors.js";
import type * as Mutator from "./Mutator.js";
import type * as MutationState from "./MutationState.js";
import * as Related from "./Related.js";
import * as RowChange from "./RowChange.js";
import * as Subset from "./Subset.js";
import * as Telemetry from "./Telemetry.js";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

/** Options for {@link make}: the channel to the host and the shared mutator registry. */
export interface MirrorOptions {
  readonly channel: MirrorChannel;
  /** The shared mutator registry (same definitions the host engine runs). */
  readonly mutators: Mutator.MutatorRegistry;
  /**
   * How often to send a liveness heartbeat to the host. Keep it shorter
   * than the host's `mirrorTimeout` so a live mirror is never reclaimed. Defaults
   * to 10 seconds.
   */
  readonly heartbeatInterval?: Duration.Input;
  /**
   * Capacity of the bounded change hub (#44). A stalled observer cannot
   * make the hub grow without limit: at capacity the hub drops the newest
   * subset keys, and the observer collapses the resulting seq gap into a full
   * re-read of its subset — lossless because the newest rows live in the
   * mirror's `Ref`. Defaults to {@link DEFAULT_CHANGE_HUB_CAPACITY}.
   */
  readonly changeHubCapacity?: number;
}

/**
 * Default bound for the mirror's change hub. Large enough that no realistic
 * burst of mirror updates fills it under normal consumption, so behaviour is
 * identical to the old unbounded hub until an observer genuinely stalls.
 */
const DEFAULT_CHANGE_HUB_CAPACITY = 1024;

/**
 * A subset key published on the change hub, tagged with a monotonic seq. A
 * consumer tracks the last seq it saw; a non-contiguous seq means the bounded
 * hub dropped a key, so the observer re-reads its subset (a full refresh)
 * rather than risk missing its own key.
 */
interface SeqKey {
  readonly seq: number;
  readonly key: string;
}

/** A backend outcome message reduced to the engine's {@link ClientEngine.MutationOutcome}. */
const outcomeOf = (
  message: MirrorProtocol.HostMessage & { readonly _tag: "MutateSettled" }
): ClientEngine.MutationOutcome =>
  message.outcome === "applied"
    ? { _tag: "applied" }
    : { _tag: "rejected", reason: message.reason ?? "" };

/**
 * Raised for a request whose answer can never arrive: the host that would
 * have answered it is gone (a restart this mirror observed via `HostReady`,
 * or this mirror's own scope closing while requests were still in flight).
 * Never left hanging — if the mutation was already journaled by the old
 * host, it is durable in its store and the next host will push it, but this
 * caller must not assume that without checking; retry is only safe once the
 * caller has verified the mutation didn't already apply.
 */
const hostUnavailable = new TransportError({
  message: "Mirror: the engine host is gone — outcome unknown, verify before retrying",
});

/**
 * Raised when an enhanced form submit's begin reaches a host that predates
 * carrying it over the mirror protocol (#536): that host answers the begin's
 * `Mutate` as an unknown mutator, and nothing was overlaid or journaled.
 */
const hostPredatesFormMutations = new TransportError({
  message:
    "Mirror.beginFormMutation: the engine host predates enhanced form submits over the mirror protocol; upgrade it",
});

/**
 * What a host that predates #536 answers a form begin with: its engine's
 * unknown-mutator message for {@link MirrorProtocol.FORM_MUTATION_MUTATOR}.
 * That host's code is fixed, so its wording is too.
 */
const unknownFormMutator = `Unknown mutator: ${MirrorProtocol.FORM_MUTATION_MUTATOR}`;

/** An empty map of requests awaiting the host's answer, keyed by requestId. */
const makePending = <A>() =>
  Ref.make(new Map<number, Deferred.Deferred<A, MutatorError | TransportError>>());

/** Fail (and clear) every deferred still waiting in `ref`, never leaving a caller hanging. */
const failPending = <A>(
  ref: Ref.Ref<Map<number, Deferred.Deferred<A, MutatorError | TransportError>>>
): Effect.Effect<void> =>
  Ref.getAndSet(ref, new Map()).pipe(
    Effect.flatMap((requests) =>
      Effect.forEach(requests.values(), (deferred) => Deferred.fail(deferred, hostUnavailable), {
        discard: true,
      })
    )
  );

/**
 * A client context's in-memory copy of a host engine's subscribed subsets: queries are answered
 * synchronously from it, and writes are forwarded to the host's journal.
 */
export interface Mirror {
  /** Validate args locally, forward to the host journal, await the ack. */
  readonly mutate: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | TransportError>;
  /**
   * Like {@link mutate}, but resolves with the mutation's authoritative backend
   * outcome (applied or permanently rejected) once the host forwards it, rather
   * than on the host journal ack.
   */
  readonly mutateWithAck: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<ClientEngine.MutationOutcome, MutatorError | TransportError>;
  /**
   * The client half of an enhanced form submit (ADR-0030 #215 §4), carried to
   * the host (#536): the host's engine overlays the Mutation under the form
   * client's id without journaling it, and holds the in-flight entry, so its
   * overlay and unpulled tail serve every mirror. Settling or abandoning the
   * returned submission tells the host; as on an engine, an acknowledgement
   * parks the effect until the pull that covers the form client releases it.
   * Fails with a `TransportError` when the host predates this, and with a
   * `MutatorError` when the args do not fit the Mutation or the host refuses
   * the begin. The signature is `ClientView`'s. A submission whose host is gone (restarted, or this mirror's
   * scope closed) settles as a no-op: its entry went with the host.
   */
  readonly beginFormMutation: NonNullable<ClientView.ClientView["beginFormMutation"]>;
  /** Register a subset with the host; rows arrive as mirror updates. */
  readonly subscribe: (subset: Subset.Subset) => Effect.Effect<void, TransportError>;
  readonly unsubscribe: (subset: Subset.Subset) => Effect.Effect<void, TransportError>;
  /**
   * Register a named query with the host (which owns the server-authoritative
   * resolution); results arrive as mirror updates under the named key.
   */
  readonly subscribeQuery: (name: string, args: unknown) => Effect.Effect<void, TransportError>;
  readonly unsubscribeQuery: (name: string, args: unknown) => Effect.Effect<void, TransportError>;
  /** The mirror's current rows for a subset (empty until hydrated). */
  readonly query: (subset: Subset.Subset) => Effect.Effect<ReadonlyArray<ClientEngine.LocalRow>>;
  /**
   * Server-fallthrough read (ADR-0025), forwarded to the host — which owns
   * the transport — and answered point-in-time, never entering the mirror.
   */
  readonly read: (
    subsets: ReadonlyArray<Subset.Subset>
  ) => Effect.Effect<ReadonlyArray<ClientEngine.ReadRow>, MutatorError | TransportError>;
  /** The mirror's current rows for a named query (empty until hydrated). */
  readonly queryNamed: (
    name: string,
    args: unknown
  ) => Effect.Effect<ReadonlyArray<ClientEngine.LocalRow>>;
  /** Emits the current rows now and on every mirror update for the subset. */
  readonly observe: (subset: Subset.Subset) => Stream.Stream<ReadonlyArray<ClientEngine.LocalRow>>;
  /** The host's pulled summary of the registration under `key` (#426); see {@link ClientView.ClientView.pulled}. */
  readonly pulled: (key: string) => Effect.Effect<Coverage.Pulled>;
  /**
   * Row-level deltas of a subset's live window (#115) — see
   * {@link ClientEngine.ClientEngine.observeChanges}. The mirror has no
   * incremental `LiveView` of its own: it diffs consecutive whole-page
   * `MirrorUpdate`s (`RowChange.diff`), which is exact because the host
   * already delivers the full current page on every change. A gap on the
   * mirror's change hub (a dropped key — CONTEXT.md's hub table) re-reads
   * the always-current `rows` Ref, same as `observe`, and is folded into a
   * `reset` batch here rather than a diff, since the skipped updates in
   * between are unknown.
   */
  readonly observeChanges: (
    subset: Subset.Subset,
    options?: { readonly includeInitial?: boolean }
  ) => Stream.Stream<ReadonlyArray<RowChange.RowChange<ClientEngine.LocalRow>>>;
  /**
   * The host engine's keyed mutation-state map (#116), mirrored so every tab
   * sees the same states the host holds. Registers interest with the host for
   * the stream's lifetime (refcounted like `observe`); emits the current map
   * now and on every host-side fold.
   */
  readonly mutationStates: Stream.Stream<MutationState.MutationStateMap>;
  /** Emits the named query's current rows now and on every mirror update. */
  readonly observeNamed: (
    name: string,
    args: unknown
  ) => Stream.Stream<ReadonlyArray<ClientEngine.LocalRow>>;
  /**
   * Auto-subscribing relational read: the HOST syncs the base and narrowed
   * foreign subsets and computes the join — the mirror receives resolved rows
   * (main-thread work stays minimal). The registration is released when the
   * scope closes. The `registry` parameter exists for {@link ClientView}
   * signature parity; the host resolves against its own registry.
   */
  readonly related: (
    registry: Collection.CollectionRegistry,
    collectionName: string,
    subset: Subset.Subset,
    edges: ReadonlyArray<string | Related.EdgeSelect>
  ) => Effect.Effect<Stream.Stream<ReadonlyArray<Related.RelatedRow>, never>, never, Scope.Scope>;
  /**
   * Hold a relational registration with the host for the scope's lifetime
   * without reading its resolved rows — an explicit pin's edge windows
   * (ADR-0029 section 2). The host runs the same reconcile loop it runs for
   * {@link related}; the signature is `ClientView`'s (the `registry`
   * parameter exists for that parity alone).
   */
  readonly pinEdges: ClientView.ClientView["pinEdges"];
}

/**
 * Connect a {@link Mirror} to the host on `options.channel`; its subscriptions are released when
 * the scope closes.
 */
export const make = (options: MirrorOptions): Effect.Effect<Mirror, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { channel, mutators } = options;
    const mirrorId = crypto.randomUUID();
    const inbox = yield* channel.subscribe;
    // Release every subscription this mirror holds when its scope closes —
    // the host refcounts subsets by mirror and tears down the last one's fiber.
    yield* Effect.addFinalizer(() =>
      channel.post({ _tag: "Disconnect", mirrorId }).pipe(Effect.ignore)
    );
    // Heartbeat so the host keeps this mirror's subsets alive (and reclaims
    // them if the mirror's context crashes without disconnecting). Fires immediately,
    // then on the interval.
    const heartbeatInterval = options.heartbeatInterval ?? "10 seconds";
    yield* Effect.forkScoped(
      Effect.forever(
        channel
          .post({ _tag: "Heartbeat", mirrorId })
          .pipe(Effect.ignore, Effect.andThen(Effect.sleep(heartbeatInterval)))
      )
    );
    // This mirror's interest ledger, keyed by subscription key. The host
    // refcounts by MIRROR (a set), so this side must speak with one voice
    // per key: Subscribe
    // when the first local interest appears (an explicit `subscribe` or an
    // observer's stream starting), Unsubscribe only when the LAST one ends.
    // The ledger doubles as the replay set for a host that (re)starts after
    // us (HostReady).
    interface Interest {
      /** Live observers of this key. */
      readonly observers: number;
      /** Pinned by an explicit `subscribe` (survives observer teardowns). */
      readonly explicit: boolean;
      readonly subscribe: MirrorProtocol.MirrorMessage;
      readonly unsubscribe: MirrorProtocol.MirrorMessage;
    }
    const interests = yield* Ref.make(new Map<string, Interest>());
    // Distinguishes a host's first-ever readiness announcement (routine — this
    // mirror has nothing in flight worth failing, and racing to fail it here
    // would clobber a request this same host is about to answer) from a later
    // one (a genuine restart, whose old in-memory bookkeeping is gone).
    const seenHostReady = yield* Ref.make(false);
    /** Add one unit of interest; posts Subscribe when it is the first. */
    const acquireInterest = (
      key: string,
      messages: {
        subscribe: MirrorProtocol.MirrorMessage;
        unsubscribe: MirrorProtocol.MirrorMessage;
      },
      kind: "observer" | "explicit"
    ) =>
      Ref.modify(interests, (map) => {
        const next = new Map(map);
        const current = next.get(key);
        const updated: Interest = {
          observers: (current?.observers ?? 0) + (kind === "observer" ? 1 : 0),
          explicit: (current?.explicit ?? false) || kind === "explicit",
          subscribe: messages.subscribe,
          unsubscribe: messages.unsubscribe,
        };
        next.set(key, updated);
        return [current === undefined, next] as const;
      }).pipe(
        Effect.flatMap((first) =>
          first ? channel.post(messages.subscribe).pipe(Effect.ignore) : Effect.void
        )
      );
    /** Drop one unit of interest; posts Unsubscribe when it was the last. */
    const releaseInterest = (key: string, kind: "observer" | "explicit") =>
      Ref.modify(interests, (map) => {
        const current = map.get(key);
        if (current === undefined) return [undefined, map] as const;
        const updated: Interest = {
          ...current,
          observers: Math.max(0, current.observers - (kind === "observer" ? 1 : 0)),
          explicit: kind === "explicit" ? false : current.explicit,
        };
        const next = new Map(map);
        if (updated.observers === 0 && !updated.explicit) {
          next.delete(key);
          return [current.unsubscribe, next] as const;
        }
        next.set(key, updated);
        return [undefined, next] as const;
      }).pipe(
        Effect.flatMap((unsubscribe) =>
          unsubscribe === undefined ? Effect.void : channel.post(unsubscribe).pipe(Effect.ignore)
        )
      );
    // Registers one unit of observer interest in `key` for as long as
    // `stream` is subscribed, releasing it when the subscriber unsubscribes.
    const withObserverRegistration = <A, E>(
      key: string,
      messages: {
        readonly subscribe: MirrorProtocol.MirrorMessage;
        readonly unsubscribe: MirrorProtocol.MirrorMessage;
      },
      stream: Stream.Stream<A, E>
    ): Stream.Stream<A, E> =>
      Stream.unwrap(
        Effect.acquireRelease(acquireInterest(key, messages, "observer"), () =>
          releaseInterest(key, "observer")
        ).pipe(Effect.as(stream))
      );
    const rows = yield* Ref.make(new Map<string, ReadonlyArray<ClientEngine.LocalRow>>());
    // Resolved relational rows, keyed by the host's related key. Kept apart
    // from `rows` because the row shape differs (base value + resolved names).
    const relatedRows = yield* Ref.make(new Map<string, ReadonlyArray<Related.RelatedRow>>());
    // The mirrored mutation-state map (#116), kept apart from `rows` because
    // it is a singleton (one map, not one per subset/named-query key) whose
    // shape differs from `LocalRow`.
    const mutationStatesRow = yield* Ref.make<MutationState.MutationStateMap>(HashMap.empty());
    // The host's pulled summaries of its registrations (#426); see `PulledRegistrations`.
    const pulledKeys = yield* Ref.make<ReadonlyMap<string, Coverage.Pulled>>(new Map());
    // Monotonic seq stamped on every published key. The `rows` Ref is updated
    // before the key is published, so a re-read after a gap always sees the
    // latest rows even for a dropped key.
    const keySeq = yield* Ref.make(0);
    // Bounded, dropping change hub (#44): a stalled observer holds keys in the
    // shared hub; at capacity the hub drops the newest keys rather than growing
    // without limit. A consumer detects a drop as a seq gap and re-reads its
    // subset from the always-current `rows` Ref — lossless under pressure,
    // identical under none.
    const keyHubCapacity = options.changeHubCapacity ?? DEFAULT_CHANGE_HUB_CAPACITY;
    const keyHub = yield* Effect.acquireRelease(
      PubSub.dropping<SeqKey>({ capacity: keyHubCapacity }),
      (hub) => PubSub.shutdown(hub)
    );
    const publishKey = (key: string): Effect.Effect<void> =>
      Effect.flatMap(
        Ref.updateAndGet(keySeq, (n) => n + 1),
        (seq) => Effect.asVoid(PubSub.publish(keyHub, { seq, key }))
      );
    const pending = yield* makePending<void>();
    // `mutateWithAck` callers awaiting the backend outcome, keyed by the same
    // requestId space as `pending` (a requestId lives in exactly one map).
    const pendingSettled = yield* makePending<ClientEngine.MutationOutcome>();
    // Fallthrough reads awaiting their host answer (ADR-0025), same
    // requestId space.
    const pendingReads = yield* makePending<ReadonlyArray<ClientEngine.ReadRow>>();
    // Enhanced form submits awaiting the host (#536): a begin and its end,
    // keyed by the begin's requestId. Kept apart from `pending` because the
    // generic `MutateAck` / `MutateError` replies carry no mirror id, and
    // another tab's request may share this requestId; only the form replies
    // (which name the mirror) complete these. An end resolves with the
    // host's settlement error, if any.
    const pendingForms = yield* makePending<Option.Option<string>>();
    const requestIds = yield* Ref.make(0);
    // Set as this mirror's scope begins to close, before the pending requests
    // are failed: a request registered after that is failed by `awaitReply`
    // itself, since no reply can reach it any more.
    const closed = yield* Ref.make(false);

    // A request left in flight when this mirror's scope closes can never be
    // answered (its host may still be alive, but nobody will read the reply)
    // — fail it rather than leave the caller hanging forever.
    yield* Effect.addFinalizer(() =>
      Ref.set(closed, true).pipe(
        Effect.andThen(
          Effect.all(
            [
              failPending(pending),
              failPending(pendingSettled),
              failPending(pendingReads),
              failPending(pendingForms),
            ],
            { discard: true }
          )
        )
      )
    );

    // Take a request's deferred out of its map and complete it. A no-op when the
    // requestId is not in this map (so both maps can be swept on `MutateError`).
    const resolveIn = <A>(
      ref: Ref.Ref<Map<number, Deferred.Deferred<A, MutatorError | TransportError>>>,
      requestId: number,
      complete: (
        deferred: Deferred.Deferred<A, MutatorError | TransportError>
      ) => Effect.Effect<boolean>
    ) =>
      Effect.gen(function* () {
        const deferred = (yield* Ref.get(ref)).get(requestId);
        if (deferred === undefined) return;
        yield* Ref.update(ref, (map) => {
          const next = new Map(map);
          next.delete(requestId);
          return next;
        });
        yield* complete(deferred);
      });

    // Complete this mirror's waiting form request (#536) from the host's reply;
    // a reply addressed to another mirror is not ours, whatever its requestId.
    const resolveForm = (
      message: { readonly mirrorId: string; readonly requestId: number },
      complete: (
        deferred: Deferred.Deferred<Option.Option<string>, MutatorError | TransportError>
      ) => Effect.Effect<boolean>
    ) =>
      message.mirrorId === mirrorId
        ? resolveIn(pendingForms, message.requestId, complete)
        : Effect.void;

    // Mirror update loop: established before `make` returns.
    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeHostMessage),
          Effect.flatMap((message) => {
            if (message === undefined) return Effect.void;
            switch (message._tag) {
              case "HostReady":
                // A host (re)started: replay every interest we hold. Past the
                // first HostReady we've ever seen, this also means whatever
                // was in flight with the OLD host is unanswerable — its
                // in-memory request bookkeeping is gone, so those replies are
                // never coming (the old host may still have journaled the
                // mutation before it died; the new host's sync loop picks
                // that up from the durable store regardless of what this
                // caller is told).
                return Ref.get(interests).pipe(
                  Effect.flatMap((map) =>
                    Effect.forEach(map.values(), (interest) =>
                      channel.post(interest.subscribe).pipe(Effect.ignore)
                    )
                  ),
                  Effect.andThen(Ref.getAndSet(seenHostReady, true)),
                  Effect.flatMap((hadSeenBefore) =>
                    hadSeenBefore
                      ? Effect.all(
                          [
                            failPending(pending),
                            failPending(pendingSettled),
                            failPending(pendingReads),
                            failPending(pendingForms),
                          ],
                          { discard: true }
                        )
                      : Effect.void
                  ),
                  Effect.asVoid
                );
              case "MirrorUpdate":
                return Ref.update(rows, (map) =>
                  new Map(map).set(
                    message.key,
                    message.rows.map((row) => ({ id: row.id, value: row.value }))
                  )
                ).pipe(Effect.andThen(publishKey(message.key)));
              case "RelatedUpdate":
                return Ref.update(relatedRows, (map) =>
                  new Map(map).set(
                    message.key,
                    message.rows.map((row) => ({
                      id: row.id,
                      value: row.value,
                      related: row.related as Record<string, Related.RelatedValue>,
                    }))
                  )
                ).pipe(Effect.andThen(publishKey(message.key)));
              case "MutationStatesUpdate":
                return Ref.set(
                  mutationStatesRow,
                  HashMap.fromIterable(
                    message.states.map((state): readonly [number, MutationState.MutationState] => [
                      state.mutationId,
                      state,
                    ])
                  )
                ).pipe(Effect.andThen(publishKey(MirrorProtocol.MUTATION_STATES_KEY)));
              case "PulledRegistrations":
                return Ref.set(
                  pulledKeys,
                  new Map(message.registrations.map((entry) => [entry.key, entry.pulled]))
                );
              case "MutateAck":
                return resolveIn(pending, message.requestId, (deferred) =>
                  Deferred.succeed(deferred, undefined)
                );
              case "MutateError": {
                // A host-side failure (never journaled): fail whichever caller
                // is waiting — `mutate` or `mutateWithAck`. Only a host that
                // predates #536 answers a form begin this way, with exactly
                // this message; it carries no mirror id, but every tab whose
                // begin it answers is talking to the same old host.
                if (message.message === unknownFormMutator) {
                  return resolveIn(pendingForms, message.requestId, (deferred) =>
                    Deferred.fail(deferred, hostPredatesFormMutations)
                  );
                }
                const error = new MutatorError({ message: message.message });
                return resolveIn(pending, message.requestId, (deferred) =>
                  Deferred.fail(deferred, error)
                ).pipe(
                  Effect.andThen(
                    resolveIn(pendingSettled, message.requestId, (deferred) =>
                      Deferred.fail(deferred, error)
                    )
                  )
                );
              }
              // A form begin's or end's answer (#536), addressed to one mirror.
              case "FormMutationBegun":
                return resolveForm(message, (deferred) =>
                  Deferred.succeed(deferred, Option.none())
                );
              case "FormMutationEnded":
                // An end succeeds, carrying the host's settlement error if any.
                return resolveForm(message, (deferred) =>
                  Deferred.succeed(deferred, Option.fromUndefinedOr(message.error))
                );
              case "FormMutationFailed":
                return resolveForm(message, (deferred) =>
                  Deferred.fail(deferred, new MutatorError({ message: message.message }))
                );
              case "MutateSettled":
                return resolveIn(pendingSettled, message.requestId, (deferred) =>
                  Deferred.succeed(deferred, outcomeOf(message))
                );
              case "ReadResult":
                return resolveIn(pendingReads, message.requestId, (deferred) =>
                  message.error === undefined
                    ? Deferred.succeed(
                        deferred,
                        message.rows.map((row) => ({ ...row, version: "" }))
                      )
                    : Deferred.fail(deferred, new TransportError({ message: message.error }))
                );
            }
          })
        )
      )
    );

    const query = (subset: Subset.Subset) =>
      Ref.get(rows).pipe(Effect.map((map) => map.get(Subset.hash(subset)) ?? []));
    const readKey = (key: string) => Ref.get(rows).pipe(Effect.map((map) => map.get(key) ?? []));
    const readRelated = (key: string) =>
      Ref.get(relatedRows).pipe(Effect.map((map) => map.get(key) ?? []));
    const readMutationStates = Ref.get(mutationStatesRow);

    // Validate + encode args against the shared registry (fail fast in the mirror;
    // the host re-validates by decoding), then forward as a `Mutate` message and
    // register a deferred so the correlated reply resolves the caller.
    const encodeArgs = (mutator: string, args: unknown) =>
      Effect.gen(function* () {
        const definition = mutators.mutators.get(mutator);
        if (definition === undefined) {
          return yield* new MutatorError({ message: `Unknown mutator: ${mutator}`, mutator });
        }
        return yield* Schema.encodeUnknownEffect(definition.args)(args).pipe(
          Effect.mapError(
            (cause) =>
              new MutatorError({
                message: `Invalid args for mutator "${mutator}"`,
                mutator,
                cause,
              })
          )
        );
      });

    // Post `message` and wait for the host's answer, correlated by `requestId`
    // through `ref`. Registered after this mirror began closing, the request
    // can never be answered, so it fails at once instead of hanging.
    const awaitReply = <A>(
      ref: Ref.Ref<Map<number, Deferred.Deferred<A, MutatorError | TransportError>>>,
      requestId: number,
      message: MirrorProtocol.MirrorMessage
    ) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<A, MutatorError | TransportError>();
        yield* Ref.update(ref, (map) => new Map(map).set(requestId, deferred));
        if (yield* Ref.get(closed)) {
          return yield* resolveIn(ref, requestId, (waiting) =>
            Deferred.fail(waiting, hostUnavailable)
          ).pipe(Effect.andThen(Deferred.await(deferred)));
        }
        yield* channel.post(message);
        return yield* Deferred.await(deferred);
      });

    const forward = <A>(
      ref: Ref.Ref<Map<number, Deferred.Deferred<A, MutatorError | TransportError>>>,
      mutator: string,
      encoded: unknown
    ) =>
      Ref.modify(requestIds, (id) => [id + 1, id + 1] as const).pipe(
        Effect.flatMap((requestId) =>
          awaitReply(ref, requestId, { _tag: "Mutate", requestId, mutator, args: encoded })
        )
      );

    // Subscribe BEFORE the first read (#84): a key published while the
    // initial read runs must land in this subscription's buffer, or a quiet
    // mirror never re-reads (gap detection needs a next item).
    const subscribeToKeyHub = Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(keyHub);
      const startSeq = yield* Ref.get(keySeq);
      const lastSeenRef = yield* Ref.make(startSeq);
      return { subscription, lastSeenRef };
    });

    // Decide whether one sequenced key warrants re-emitting: skip a
    // stale/duplicate seq; on a gap (a dropped key) refresh (the dropped key
    // might have been ours — the backing Ref holds latest); otherwise trigger
    // only when our own key changed. Under no pressure (contiguous seqs) this
    // is exactly a key-filter.
    const decideTrigger = (
      key: string,
      lastSeenRef: Ref.Ref<number>,
      item: SeqKey
    ): Effect.Effect<Option.Option<{ readonly gapped: boolean }>> =>
      Effect.gen(function* () {
        const lastSeen = yield* Ref.get(lastSeenRef);
        if (item.seq <= lastSeen) return Option.none();
        const gapped = item.seq > lastSeen + 1;
        yield* Ref.set(lastSeenRef, item.seq);
        if (gapped) yield* Metric.update(Telemetry.mirrorRefreshesTotal, 1);
        return gapped || item.key === key ? Option.some({ gapped }) : Option.none();
      });

    // Emits `read`'s current value now and again whenever `key` changes on
    // the hub, per {@link decideTrigger}.
    const observeKey = <A>(key: string, read: Effect.Effect<A>): Stream.Stream<A> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { subscription, lastSeenRef } = yield* subscribeToKeyHub;
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((item) => decideTrigger(key, lastSeenRef, item)),
              Stream.filter(Option.isSome),
              Stream.mapEffect(() => read)
            )
          );
        })
      );

    // Row-level deltas over `key`'s whole-page reads (#115): a trigger
    // decision like {@link observeKey}, but also carrying whether the
    // trigger was a gap (`reset`, since the skipped updates are unknown) so
    // the caller can diff or reset instead of just re-reading.
    const observeKeyChanges = (
      key: string,
      read: Effect.Effect<ReadonlyArray<ClientEngine.LocalRow>>,
      options?: { readonly includeInitial?: boolean }
    ): Stream.Stream<ReadonlyArray<RowChange.RowChange<ClientEngine.LocalRow>>> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { subscription, lastSeenRef } = yield* subscribeToKeyHub;
          const initialRows = yield* read;
          const previousRef = yield* Ref.make(initialRows);
          const initial: ReadonlyArray<ReadonlyArray<RowChange.RowChange<ClientEngine.LocalRow>>> =
            options?.includeInitial === true && Arr.isReadonlyArrayNonEmpty(initialRows)
              ? [RowChange.enters(initialRows)]
              : [];
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect((item) => decideTrigger(key, lastSeenRef, item)),
            Stream.filter(Option.isSome),
            Stream.mapEffect((option) =>
              Effect.gen(function* () {
                const previous = yield* Ref.get(previousRef);
                const next = yield* read;
                yield* Ref.set(previousRef, next);
                return option.value.gapped ? RowChange.reset(next) : RowChange.diff(previous, next);
              })
            ),
            Stream.filter((batch) => Arr.isReadonlyArrayNonEmpty(batch))
          );
          return Stream.concat(Stream.fromIterable(initial), live);
        })
      );

    // One unit of interest in a relational registration for the scope's
    // lifetime (counted like an observer's: pins of one registration add
    // up, and the host is told once). Returns the key the rows arrive under.
    const holdRelated = (
      collectionName: string,
      subset: Subset.Subset,
      edgeInputs: ReadonlyArray<string | Related.EdgeSelect>
    ): Effect.Effect<string, never, Scope.Scope> =>
      Effect.gen(function* () {
        const edges = edgeInputs.map(Related.edgeSelect);
        const key = MirrorProtocol.relatedKey(collectionName, subset, edges);
        const registration = { mirrorId, collection: collectionName, subset, edges };
        yield* acquireInterest(
          key,
          {
            subscribe: { _tag: "SubscribeRelated", ...registration },
            unsubscribe: { _tag: "UnsubscribeRelated", ...registration },
          },
          "observer"
        );
        yield* Effect.addFinalizer(() => releaseInterest(key, "observer"));
        return key;
      });

    // Ask the host to end a form submission (settle on a ruling, or abandon
    // it) and wait for it to have done so. A host that is gone, or a mirror
    // that has closed, took the entry with it, so that is an end too; a
    // settlement the host's store failed is the caller's `StoreError`.
    const endForm = (requestId: number, ruling: Option.Option<ClientEngine.FormRuling>) =>
      awaitReply(
        pendingForms,
        requestId,
        Option.match(ruling, {
          onNone: () => ({ _tag: "EndFormMutation", mirrorId, requestId }) as const,
          onSome: (value) =>
            ({ _tag: "EndFormMutation", mirrorId, requestId, ruling: value }) as const,
        })
      ).pipe(
        Effect.catchTag(["TransportError", "MutatorError"], () =>
          Effect.succeed(Option.none<string>())
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (message) => Effect.fail(new StoreError({ message })),
          })
        )
      );

    return {
      mutate: (mutator, args) =>
        encodeArgs(mutator, args).pipe(
          Effect.flatMap((encoded) => forward(pending, mutator, encoded))
        ),
      beginFormMutation: (form, mutator, args) =>
        Effect.gen(function* () {
          const encoded = yield* encodeArgs(mutator, args);
          const requestId = yield* Ref.updateAndGet(requestIds, (n) => n + 1);
          const begin: MirrorProtocol.FormMutationBegin = {
            mirrorId,
            form,
            mutator,
            args: encoded,
          };
          yield* awaitReply(pendingForms, requestId, {
            _tag: "Mutate",
            requestId,
            mutator: MirrorProtocol.FORM_MUTATION_MUTATOR,
            args: begin,
          });
          // Exactly one of settle or abandon ends it; later calls do nothing.
          const open = yield* Ref.make(true);
          const end = (ruling: Option.Option<ClientEngine.FormRuling>) =>
            Ref.getAndSet(open, false).pipe(
              Effect.flatMap((wasOpen) => (wasOpen ? endForm(requestId, ruling) : Effect.void))
            );
          const submission: ClientEngine.FormSubmission = {
            form,
            settle: (ruling) => end(Option.some(ruling)),
            abandon: end(Option.none()).pipe(Effect.ignore),
          };
          return submission;
        }),
      mutateWithAck: (mutator, args) =>
        encodeArgs(mutator, args).pipe(
          Effect.flatMap((encoded) => forward(pendingSettled, mutator, encoded))
        ),
      subscribe: (subset) =>
        acquireInterest(
          Subset.hash(subset),
          {
            subscribe: { _tag: "Subscribe", mirrorId, subset },
            unsubscribe: { _tag: "Unsubscribe", mirrorId, subset },
          },
          "explicit"
        ),
      unsubscribe: (subset) => releaseInterest(Subset.hash(subset), "explicit"),
      subscribeQuery: (name, args) =>
        acquireInterest(
          MirrorProtocol.namedKey(name, args),
          {
            subscribe: { _tag: "SubscribeNamed", mirrorId, name, args },
            unsubscribe: { _tag: "UnsubscribeNamed", mirrorId, name, args },
          },
          "explicit"
        ),
      unsubscribeQuery: (name, args) =>
        releaseInterest(MirrorProtocol.namedKey(name, args), "explicit"),
      query,
      // The server-fallthrough read (ADR-0025): forwarded to the host, which
      // owns the transport; correlated by requestId like mutations.
      read: (subsets) =>
        Effect.gen(function* () {
          const requestId = yield* Ref.updateAndGet(requestIds, (n) => n + 1);
          const deferred = yield* Deferred.make<
            ReadonlyArray<ClientEngine.ReadRow>,
            MutatorError | TransportError
          >();
          yield* Ref.update(pendingReads, (map) => new Map(map).set(requestId, deferred));
          yield* channel.post({ _tag: "Read", requestId, subsets });
          return yield* Deferred.await(deferred);
        }),
      queryNamed: (name, args) => readKey(MirrorProtocol.namedKey(name, args)),
      pulled: (key: string) =>
        Ref.get(pulledKeys).pipe(Effect.map((map) => map.get(key) ?? Coverage.NOT_PULLED)),
      // Observing auto-registers with the host for the stream's lifetime:
      // the mirror only carries keys someone subscribed, so a live read IS a
      // subscription intent (refcounted; an explicit `subscribe` still pins a
      // subset beyond any observer's lifetime).
      observe: (subset) => {
        const key = Subset.hash(subset);
        return withObserverRegistration(
          key,
          {
            subscribe: { _tag: "Subscribe", mirrorId, subset },
            unsubscribe: { _tag: "Unsubscribe", mirrorId, subset },
          },
          observeKey(key, query(subset))
        );
      },
      observeChanges: (subset, changeOptions) => {
        const key = Subset.hash(subset);
        return withObserverRegistration(
          key,
          {
            subscribe: { _tag: "Subscribe", mirrorId, subset },
            unsubscribe: { _tag: "Unsubscribe", mirrorId, subset },
          },
          observeKeyChanges(key, query(subset), changeOptions)
        );
      },
      observeNamed: (name, args) => {
        const key = MirrorProtocol.namedKey(name, args);
        return withObserverRegistration(
          key,
          {
            subscribe: { _tag: "SubscribeNamed", mirrorId, name, args },
            unsubscribe: { _tag: "UnsubscribeNamed", mirrorId, name, args },
          },
          observeKey(key, readKey(key))
        );
      },
      mutationStates: withObserverRegistration(
        MirrorProtocol.MUTATION_STATES_KEY,
        {
          subscribe: { _tag: "SubscribeMutationStates", mirrorId },
          unsubscribe: { _tag: "UnsubscribeMutationStates", mirrorId },
        },
        observeKey(MirrorProtocol.MUTATION_STATES_KEY, readMutationStates)
      ),
      related: (_registry, collectionName, subset, edgeInputs) =>
        holdRelated(collectionName, subset, edgeInputs).pipe(
          Effect.map((key) => observeKey(key, readRelated(key)))
        ),
      pinEdges: (_registry, collectionName, subset, edgeInputs) =>
        Effect.asVoid(holdRelated(collectionName, subset, edgeInputs)),
    };
  });
