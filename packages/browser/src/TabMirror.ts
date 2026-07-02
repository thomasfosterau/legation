/**
 * TabMirror
 *
 * The tab side of ADR-0010: an in-memory mirror of subscribed subsets,
 * hydrated and kept current by engine-host broadcasts, with queries served
 * synchronously from the mirror. Mutations validate locally against the
 * shared mutator registry (fail fast in the tab), then forward to the host
 * journal in encoded form and await the host's acknowledgement.
 */

import {
  ClientEngine,
  MutatorError,
  Subset,
  Telemetry,
  TransportError,
  type Mutator,
} from "@legation/effect";
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

export interface TabMirrorOptions {
  readonly channel: MirrorChannel;
  /** The shared mutator registry (same definitions the host engine runs). */
  readonly mutators: Mutator.MutatorRegistry;
  /**
   * How often to send a liveness heartbeat to the host. Keep it shorter
   * than the host's `tabTimeout` so a live tab is never reclaimed. Defaults
   * to 10 seconds.
   */
  readonly heartbeatInterval?: Duration.Input;
  /**
   * Capacity of the bounded change hub (#44). A stalled tab observer cannot
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
 * identical to the old unbounded hub until a tab observer genuinely stalls.
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

export interface TabMirror {
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
  /** The mirror's current rows for a subset (empty until hydrated). */
  readonly query: (subset: Subset.Subset) => Effect.Effect<ReadonlyArray<ClientEngine.LocalRow>>;
  /** Emits the current rows now and on every mirror update for the subset. */
  readonly observe: (subset: Subset.Subset) => Stream.Stream<ReadonlyArray<ClientEngine.LocalRow>>;
}

export const make = (options: TabMirrorOptions): Effect.Effect<TabMirror, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { channel, mutators } = options;
    const tabId = crypto.randomUUID();
    const inbox = yield* channel.subscribe;
    // Release every subscription this tab holds when its scope closes — the
    // host refcounts subsets by tab and tears down the last one's fiber.
    yield* Effect.addFinalizer(() =>
      channel.post({ _tag: "Disconnect", tabId }).pipe(Effect.ignore)
    );
    // Heartbeat so the host keeps this tab's subsets alive (and reclaims
    // them if the tab crashes without disconnecting). Fires immediately,
    // then on the interval.
    const heartbeatInterval = options.heartbeatInterval ?? "10 seconds";
    yield* Effect.forkScoped(
      Effect.forever(
        channel
          .post({ _tag: "Heartbeat", tabId })
          .pipe(Effect.ignore, Effect.andThen(Effect.sleep(heartbeatInterval)))
      )
    );
    const rows = yield* Ref.make(new Map<string, ReadonlyArray<ClientEngine.LocalRow>>());
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
              case "MirrorUpdate":
                return Ref.update(rows, (map) =>
                  new Map(map).set(
                    message.key,
                    message.rows.map((row) => ({ id: row.id, value: row.value }))
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

    // Validate + encode args against the shared registry (fail fast in the tab;
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

    return {
      mutate: (mutator, args) =>
        encodeArgs(mutator, args).pipe(
          Effect.flatMap((encoded) => forward(pending, mutator, encoded))
        ),
      mutateWithAck: (mutator, args) =>
        encodeArgs(mutator, args).pipe(
          Effect.flatMap((encoded) => forward(pendingSettled, mutator, encoded))
        ),
      subscribe: (subset) => channel.post({ _tag: "Subscribe", tabId, subset }),
      unsubscribe: (subset) => channel.post({ _tag: "Unsubscribe", tabId, subset }),
      query,
      observe: (subset) => {
        const key = Subset.hash(subset);
        // Decide whether one sequenced key warrants re-emitting this subset's
        // rows: skip a stale/duplicate seq; on a gap (a dropped key) refresh
        // (the dropped key might have been ours — the `rows` Ref holds latest);
        // otherwise emit only when our own key changed. Under no pressure
        // (contiguous seqs) this is exactly the old key-filter behaviour.
        const decide = (
          lastSeenRef: Ref.Ref<number>,
          item: SeqKey
        ): Effect.Effect<Option.Option<ReadonlyArray<ClientEngine.LocalRow>>> =>
          Effect.gen(function* () {
            const lastSeen = yield* Ref.get(lastSeenRef);
            if (item.seq <= lastSeen) return Option.none();
            const gapped = item.seq > lastSeen + 1;
            yield* Ref.set(lastSeenRef, item.seq);
            if (gapped) yield* Metric.update(Telemetry.mirrorRefreshesTotal, 1);
            return gapped || item.key === key ? Option.some(yield* query(subset)) : Option.none();
          });
        return Stream.unwrap(
          Effect.gen(function* () {
            const startSeq = yield* Ref.get(keySeq);
            const lastSeenRef = yield* Ref.make(startSeq);
            return Stream.concat(
              Stream.fromEffect(query(subset)),
              Stream.fromPubSub(keyHub).pipe(
                Stream.mapEffect((item) => decide(lastSeenRef, item)),
                Stream.filter(Option.isSome),
                Stream.map((option) => option.value)
              )
            );
          })
        );
      },
    };
  });
