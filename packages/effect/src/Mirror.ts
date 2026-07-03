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
import type * as Collection from "./Collection.js";
import { MutatorError, TransportError } from "./Errors.js";
import type * as Mutator from "./Mutator.js";
import * as Related from "./Related.js";
import * as Subset from "./Subset.js";
import * as Telemetry from "./Telemetry.js";
import {
  Deferred,
  type Duration,
  Effect,
  Metric,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

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
  /** The mirror's current rows for a named query (empty until hydrated). */
  readonly queryNamed: (
    name: string,
    args: unknown
  ) => Effect.Effect<ReadonlyArray<ClientEngine.LocalRow>>;
  /** Emits the current rows now and on every mirror update for the subset. */
  readonly observe: (subset: Subset.Subset) => Stream.Stream<ReadonlyArray<ClientEngine.LocalRow>>;
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
}

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
    const rows = yield* Ref.make(new Map<string, ReadonlyArray<ClientEngine.LocalRow>>());
    // Resolved relational rows, keyed by the host's related key. Kept apart
    // from `rows` because the row shape differs (base value + resolved names).
    const relatedRows = yield* Ref.make(new Map<string, ReadonlyArray<Related.RelatedRow>>());
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
    const pending = yield* Ref.make(
      new Map<number, Deferred.Deferred<void, MutatorError | TransportError>>()
    );
    // `mutateWithAck` callers awaiting the backend outcome, keyed by the same
    // requestId space as `pending` (a requestId lives in exactly one map).
    const pendingSettled = yield* Ref.make(
      new Map<
        number,
        Deferred.Deferred<ClientEngine.MutationOutcome, MutatorError | TransportError>
      >()
    );
    const requestIds = yield* Ref.make(0);

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

    // Mirror update loop: established before `make` returns.
    yield* Effect.forkScoped(
      Effect.forever(
        inbox.take.pipe(
          Effect.flatMap(MirrorProtocol.decodeHostMessage),
          Effect.flatMap((message) => {
            if (message === undefined) return Effect.void;
            switch (message._tag) {
              case "HostReady":
                // A host (re)started: replay every interest we hold.
                return Ref.get(interests).pipe(
                  Effect.flatMap((map) =>
                    Effect.forEach(map.values(), (interest) =>
                      channel.post(interest.subscribe).pipe(Effect.ignore)
                    )
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
              case "MutateAck":
                return resolveIn(pending, message.requestId, (deferred) =>
                  Deferred.succeed(deferred, undefined)
                );
              case "MutateError": {
                // A host-side failure (never journaled): fail whichever caller
                // is waiting — `mutate` or `mutateWithAck`.
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
              case "MutateSettled":
                return resolveIn(pendingSettled, message.requestId, (deferred) =>
                  Deferred.succeed(deferred, outcomeOf(message))
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

    const forward = <A>(
      ref: Ref.Ref<Map<number, Deferred.Deferred<A, MutatorError | TransportError>>>,
      mutator: string,
      encoded: unknown
    ) =>
      Effect.gen(function* () {
        const requestId = yield* Ref.modify(requestIds, (id) => [id + 1, id + 1]);
        const deferred = yield* Deferred.make<A, MutatorError | TransportError>();
        yield* Ref.update(ref, (map) => new Map(map).set(requestId, deferred));
        yield* channel.post({ _tag: "Mutate", requestId, mutator, args: encoded });
        return yield* Deferred.await(deferred);
      });

    // Emits `read`'s current value now and again whenever `key` changes on the
    // hub. Decide whether one sequenced key warrants re-emitting: skip a
    // stale/duplicate seq; on a gap (a dropped key) refresh (the dropped key
    // might have been ours — the backing Ref holds latest); otherwise emit
    // only when our own key changed. Under no pressure (contiguous seqs) this
    // is exactly a key-filter.
    const observeKey = <A>(key: string, read: Effect.Effect<A>): Stream.Stream<A> => {
      const decide = (
        lastSeenRef: Ref.Ref<number>,
        item: SeqKey
      ): Effect.Effect<Option.Option<A>> =>
        Effect.gen(function* () {
          const lastSeen = yield* Ref.get(lastSeenRef);
          if (item.seq <= lastSeen) return Option.none();
          const gapped = item.seq > lastSeen + 1;
          yield* Ref.set(lastSeenRef, item.seq);
          if (gapped) yield* Metric.update(Telemetry.mirrorRefreshesTotal, 1);
          return gapped || item.key === key ? Option.some(yield* read) : Option.none();
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe BEFORE the first read (#84): a key published while the
          // initial read runs must land in this subscription's buffer, or a
          // quiet mirror never re-reads (gap detection needs a next item).
          const subscription = yield* PubSub.subscribe(keyHub);
          const startSeq = yield* Ref.get(keySeq);
          const lastSeenRef = yield* Ref.make(startSeq);
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((item) => decide(lastSeenRef, item)),
              Stream.filter(Option.isSome),
              Stream.map((option) => option.value)
            )
          );
        })
      );
    };

    return {
      mutate: (mutator, args) =>
        encodeArgs(mutator, args).pipe(
          Effect.flatMap((encoded) => forward(pending, mutator, encoded))
        ),
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
      queryNamed: (name, args) => readKey(MirrorProtocol.namedKey(name, args)),
      // Observing auto-registers with the host for the stream's lifetime:
      // the mirror only carries keys someone subscribed, so a live read IS a
      // subscription intent (refcounted; an explicit `subscribe` still pins a
      // subset beyond any observer's lifetime).
      observe: (subset) => {
        const key = Subset.hash(subset);
        return Stream.unwrap(
          Effect.acquireRelease(
            acquireInterest(
              key,
              {
                subscribe: { _tag: "Subscribe", mirrorId, subset },
                unsubscribe: { _tag: "Unsubscribe", mirrorId, subset },
              },
              "observer"
            ),
            () => releaseInterest(key, "observer")
          ).pipe(Effect.as(observeKey(key, query(subset))))
        );
      },
      observeNamed: (name, args) => {
        const key = MirrorProtocol.namedKey(name, args);
        return Stream.unwrap(
          Effect.acquireRelease(
            acquireInterest(
              key,
              {
                subscribe: { _tag: "SubscribeNamed", mirrorId, name, args },
                unsubscribe: { _tag: "UnsubscribeNamed", mirrorId, name, args },
              },
              "observer"
            ),
            () => releaseInterest(key, "observer")
          ).pipe(Effect.as(observeKey(key, readKey(key))))
        );
      },
      related: (_registry, collectionName, subset, edgeInputs) =>
        Effect.gen(function* () {
          const edges = edgeInputs.map(Related.edgeSelect);
          const key = MirrorProtocol.relatedKey(collectionName, subset, edges);
          yield* acquireInterest(
            key,
            {
              subscribe: {
                _tag: "SubscribeRelated",
                mirrorId,
                collection: collectionName,
                subset,
                edges,
              },
              unsubscribe: {
                _tag: "UnsubscribeRelated",
                mirrorId,
                collection: collectionName,
                subset,
                edges,
              },
            },
            "observer"
          );
          yield* Effect.addFinalizer(() => releaseInterest(key, "observer"));
          return observeKey(key, readRelated(key));
        }),
    };
  });
