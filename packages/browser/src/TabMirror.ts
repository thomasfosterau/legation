/**
 * TabMirror
 *
 * The tab side of ADR-0010: an in-memory mirror of subscribed subsets,
 * hydrated and kept current by engine-host broadcasts, with queries served
 * synchronously from the mirror. Mutations validate locally against the
 * shared mutator registry (fail fast in the tab), then forward to the host
 * journal in encoded form and await the host's acknowledgement.
 */

import { ClientEngine, MutatorError, Subset, TransportError, type Mutator } from "@legation/effect";
import { Deferred, type Duration, Effect, PubSub, Ref, Schema, Scope, Stream } from "effect";
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
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (hub) =>
      PubSub.shutdown(hub)
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
                ).pipe(Effect.andThen(Effect.asVoid(PubSub.publish(changes, message.key))));
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
        return Stream.concat(
          Stream.fromEffect(query(subset)),
          Stream.fromPubSub(changes).pipe(
            Stream.filter((changed) => changed === key),
            Stream.mapEffect(() => query(subset))
          )
        );
      },
    };
  });
