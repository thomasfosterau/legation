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
  TransportError,
  type Mutator,
} from "@thomasfosterau/effect-sync-core";
import { Deferred, Effect, PubSub, Ref, Schema, Scope, Stream } from "effect";
import type { MirrorChannel } from "./MirrorChannel.js";
import * as MirrorProtocol from "./MirrorProtocol.js";

export interface TabMirrorOptions {
  readonly channel: MirrorChannel;
  /** The shared mutator registry (same definitions the host engine runs). */
  readonly mutators: Mutator.MutatorRegistry;
}

export interface TabMirror {
  /** Validate args locally, forward to the host journal, await the ack. */
  readonly mutate: (
    mutator: string,
    args: unknown
  ) => Effect.Effect<void, MutatorError | TransportError>;
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
    const rows = yield* Ref.make(new Map<string, ReadonlyArray<ClientEngine.LocalRow>>());
    const changes = yield* Effect.acquireRelease(PubSub.unbounded<string>(), (hub) =>
      PubSub.shutdown(hub)
    );
    const pending = yield* Ref.make(
      new Map<number, Deferred.Deferred<void, MutatorError | TransportError>>()
    );
    const requestIds = yield* Ref.make(0);

    const resolve = (
      requestId: number,
      complete: (
        deferred: Deferred.Deferred<void, MutatorError | TransportError>
      ) => Effect.Effect<boolean>
    ) =>
      Effect.gen(function* () {
        const deferred = (yield* Ref.get(pending)).get(requestId);
        if (deferred === undefined) return;
        yield* Ref.update(pending, (map) => {
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
                return resolve(message.requestId, (deferred) =>
                  Deferred.succeed(deferred, undefined)
                );
              case "MutateError":
                return resolve(message.requestId, (deferred) =>
                  Deferred.fail(deferred, new MutatorError({ message: message.message }))
                );
            }
          })
        )
      )
    );

    const query = (subset: Subset.Subset) =>
      Ref.get(rows).pipe(Effect.map((map) => map.get(Subset.hash(subset)) ?? []));

    return {
      mutate: (mutator, args) =>
        Effect.gen(function* () {
          const definition = mutators.mutators.get(mutator);
          if (definition === undefined) {
            return yield* new MutatorError({ message: `Unknown mutator: ${mutator}`, mutator });
          }
          // Fail fast in the tab; the host re-validates by decoding.
          const encoded = yield* Schema.encodeUnknownEffect(definition.args)(args).pipe(
            Effect.mapError(
              (cause) =>
                new MutatorError({
                  message: `Invalid args for mutator "${mutator}"`,
                  mutator,
                  cause,
                })
            )
          );
          const requestId = yield* Ref.modify(requestIds, (id) => [id + 1, id + 1]);
          const deferred = yield* Deferred.make<void, MutatorError | TransportError>();
          yield* Ref.update(pending, (map) => new Map(map).set(requestId, deferred));
          yield* channel.post({ _tag: "Mutate", requestId, mutator, args: encoded });
          yield* Deferred.await(deferred);
        }),
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
